#include "clipboard_image.h"

#include <flutter/standard_method_codec.h>
#include <shellapi.h>
#include <wincodec.h>
#include <wrl/client.h>

#include <cstddef>
#include <cstdint>
#include <cstring>
#include <optional>
#include <string>
#include <vector>

#include "utils.h"

namespace {

using Microsoft::WRL::ComPtr;
using Bytes = std::vector<uint8_t>;

// The largest picture taken from, or put on, the clipboard: 8192 x 8192.
constexpr uint64_t kMaxPixels = 8192ull * 8192ull;

constexpr uint8_t kPngSignature[] = {0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A};

// OpenClipboard fails while another program holds it, so ask a few times.
class ClipboardLock {
 public:
  explicit ClipboardLock(HWND owner) {
    for (int attempt = 0; attempt < 5 && !open_; attempt++) {
      open_ = ::OpenClipboard(owner) != FALSE;
      if (!open_) {
        ::Sleep(10);
      }
    }
  }
  ~ClipboardLock() {
    if (open_) {
      ::CloseClipboard();
    }
  }
  bool open() const { return open_; }

 private:
  bool open_ = false;
};

// A clipboard handle's memory, locked for the scope.
class GlobalView {
 public:
  explicit GlobalView(HANDLE handle)
      : handle_(handle),
        data_(handle == nullptr ? nullptr : ::GlobalLock(handle)),
        size_(handle == nullptr ? 0 : ::GlobalSize(handle)) {}
  ~GlobalView() {
    if (data_ != nullptr) {
      ::GlobalUnlock(handle_);
    }
  }
  const uint8_t* data() const { return static_cast<const uint8_t*>(data_); }
  size_t size() const { return data_ == nullptr ? 0 : size_; }

 private:
  HANDLE handle_;
  void* data_;
  size_t size_;
};

ComPtr<IWICImagingFactory> Factory() {
  ComPtr<IWICImagingFactory> factory;
  ::CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER,
                     IID_PPV_ARGS(&factory));
  return factory;
}

// A PNG's own length. A clipboard block can be longer than what was put in it.
size_t PngLength(const uint8_t* data, size_t size) {
  size_t offset = sizeof(kPngSignature);
  while (offset + 12 <= size) {
    const size_t length = (size_t{data[offset]} << 24) |
                          (size_t{data[offset + 1]} << 16) |
                          (size_t{data[offset + 2]} << 8) | data[offset + 3];
    if (length > size - offset - 12) {
      return size;
    }
    const bool end = std::memcmp(data + offset + 4, "IEND", 4) == 0;
    offset += 12 + length;
    if (end) {
      return offset;
    }
  }
  return size;
}

std::optional<Bytes> EncodePng(IWICImagingFactory* factory,
                               IWICBitmapSource* source) {
  ComPtr<IWICFormatConverter> converter;
  ComPtr<IStream> stream;
  ComPtr<IWICBitmapEncoder> encoder;
  ComPtr<IWICBitmapFrameEncode> frame;
  UINT width = 0;
  UINT height = 0;
  WICPixelFormatGUID format = GUID_WICPixelFormat32bppBGRA;
  if (FAILED(factory->CreateFormatConverter(&converter)) ||
      FAILED(converter->Initialize(source, GUID_WICPixelFormat32bppBGRA,
                                   WICBitmapDitherTypeNone, nullptr, 0.0,
                                   WICBitmapPaletteTypeCustom)) ||
      FAILED(converter->GetSize(&width, &height)) ||
      FAILED(::CreateStreamOnHGlobal(nullptr, TRUE, &stream)) ||
      FAILED(factory->CreateEncoder(GUID_ContainerFormatPng, nullptr,
                                    &encoder)) ||
      FAILED(encoder->Initialize(stream.Get(), WICBitmapEncoderNoCache)) ||
      FAILED(encoder->CreateNewFrame(&frame, nullptr)) ||
      FAILED(frame->Initialize(nullptr)) ||
      FAILED(frame->SetSize(width, height)) ||
      FAILED(frame->SetPixelFormat(&format)) ||
      FAILED(frame->WriteSource(converter.Get(), nullptr)) ||
      FAILED(frame->Commit()) || FAILED(encoder->Commit())) {
    return std::nullopt;
  }
  STATSTG stat = {};
  if (FAILED(stream->Stat(&stat, STATFLAG_NONAME)) ||
      stat.cbSize.QuadPart > 512ull * 1024 * 1024) {
    return std::nullopt;
  }
  Bytes png(static_cast<size_t>(stat.cbSize.QuadPart));
  LARGE_INTEGER start = {};
  ULONG read = 0;
  if (FAILED(stream->Seek(start, STREAM_SEEK_SET, nullptr)) ||
      FAILED(stream->Read(png.data(), static_cast<ULONG>(png.size()), &read)) ||
      read != png.size()) {
    return std::nullopt;
  }
  return png;
}

// A 24- or 32-bit DIB (CF_DIB, CF_DIBV5) as PNG. Other depths, compressions
// and channel orders answer nullopt, and the caller tries CF_BITMAP instead.
std::optional<Bytes> PngFromDib(IWICImagingFactory* factory,
                                const uint8_t* data, size_t size) {
  if (data == nullptr || size < sizeof(BITMAPINFOHEADER)) {
    return std::nullopt;
  }
  BITMAPINFOHEADER header;
  std::memcpy(&header, data, sizeof(header));
  if (header.biSize < sizeof(BITMAPINFOHEADER) || header.biSize > size ||
      header.biWidth <= 0 || header.biHeight == 0 || header.biPlanes != 1) {
    return std::nullopt;
  }
  const bool bits32 = header.biBitCount == 32;
  const bool plain24 = header.biBitCount == 24 && header.biCompression == BI_RGB;
  const bool plain32 = bits32 && (header.biCompression == BI_RGB ||
                                  header.biCompression == BI_BITFIELDS);
  if (!plain24 && !plain32) {
    return std::nullopt;
  }
  size_t offset = header.biSize;
  if (header.biCompression == BI_BITFIELDS) {
    DWORD masks[3] = {};
    if (header.biSize >= sizeof(BITMAPV4HEADER)) {
      std::memcpy(masks, data + offsetof(BITMAPV4HEADER, bV4RedMask),
                  sizeof(masks));
    } else {
      if (offset + sizeof(masks) > size) {
        return std::nullopt;
      }
      std::memcpy(masks, data + offset, sizeof(masks));
      offset += sizeof(masks);
    }
    if (masks[0] != 0x00FF0000 || masks[1] != 0x0000FF00 ||
        masks[2] != 0x000000FF) {
      return std::nullopt;
    }
  }
  offset += static_cast<size_t>(header.biClrUsed) * sizeof(RGBQUAD);
  const bool bottom_up = header.biHeight > 0;
  const uint64_t width = static_cast<uint64_t>(header.biWidth);
  const uint64_t height = static_cast<uint64_t>(
      bottom_up ? static_cast<int64_t>(header.biHeight)
                : -static_cast<int64_t>(header.biHeight));
  if (width * height > kMaxPixels) {
    return std::nullopt;
  }
  const uint64_t stride = ((width * header.biBitCount + 31) / 32) * 4;
  if (offset + stride * height > size) {
    return std::nullopt;
  }
  const size_t columns = static_cast<size_t>(width);
  const size_t rows = static_cast<size_t>(height);
  const size_t pixel_size = bits32 ? 4 : 3;
  Bytes pixels(columns * rows * 4);
  bool any_alpha = false;
  for (size_t y = 0; y < rows; y++) {
    const uint8_t* row = data + offset +
                         static_cast<size_t>(stride) *
                             (bottom_up ? rows - 1 - y : y);
    uint8_t* out = pixels.data() + y * columns * 4;
    for (size_t x = 0; x < columns; x++) {
      const uint8_t* in = row + x * pixel_size;
      out[x * 4 + 0] = in[0];
      out[x * 4 + 1] = in[1];
      out[x * 4 + 2] = in[2];
      out[x * 4 + 3] = bits32 ? in[3] : 0xFF;
      any_alpha = any_alpha || (bits32 && in[3] != 0);
    }
  }
  // A 32-bit DIB whose every alpha is 0 is an opaque picture whose fourth
  // byte is padding.
  if (bits32 && !any_alpha) {
    for (size_t i = 3; i < pixels.size(); i += 4) {
      pixels[i] = 0xFF;
    }
  }
  ComPtr<IWICBitmap> bitmap;
  if (FAILED(factory->CreateBitmapFromMemory(
          static_cast<UINT>(columns), static_cast<UINT>(rows),
          GUID_WICPixelFormat32bppBGRA, static_cast<UINT>(columns * 4),
          static_cast<UINT>(pixels.size()), pixels.data(), &bitmap))) {
    return std::nullopt;
  }
  return EncodePng(factory, bitmap.Get());
}

flutter::EncodableValue ReadImagePng(HWND owner) {
  ClipboardLock lock(owner);
  if (!lock.open()) {
    return flutter::EncodableValue();
  }
  // The picture as its program encoded it: browsers put PNG beside the bitmap.
  for (const wchar_t* name : {L"PNG", L"image/png"}) {
    const UINT format = ::RegisterClipboardFormatW(name);
    if (format == 0 || !::IsClipboardFormatAvailable(format)) {
      continue;
    }
    GlobalView view(::GetClipboardData(format));
    if (view.size() > sizeof(kPngSignature) &&
        std::memcmp(view.data(), kPngSignature, sizeof(kPngSignature)) == 0) {
      const size_t length = PngLength(view.data(), view.size());
      return flutter::EncodableValue(Bytes(view.data(), view.data() + length));
    }
  }
  ComPtr<IWICImagingFactory> factory = Factory();
  if (!factory) {
    return flutter::EncodableValue();
  }
  const UINT dib_formats[] = {CF_DIBV5, CF_DIB};
  for (const UINT format : dib_formats) {
    if (!::IsClipboardFormatAvailable(format)) {
      continue;
    }
    GlobalView view(::GetClipboardData(format));
    if (auto png = PngFromDib(factory.Get(), view.data(), view.size())) {
      return flutter::EncodableValue(std::move(*png));
    }
  }
  if (::IsClipboardFormatAvailable(CF_BITMAP)) {
    auto bitmap = static_cast<HBITMAP>(::GetClipboardData(CF_BITMAP));
    ComPtr<IWICBitmap> source;
    if (bitmap != nullptr &&
        SUCCEEDED(factory->CreateBitmapFromHBITMAP(
            bitmap, nullptr, WICBitmapIgnoreAlpha, &source))) {
      if (auto png = EncodePng(factory.Get(), source.Get())) {
        return flutter::EncodableValue(std::move(*png));
      }
    }
  }
  // No picture (the normal case for a text paste): Dart pastes the text.
  return flutter::EncodableValue();
}

bool WriteImagePng(HWND owner, const Bytes& png) {
  ComPtr<IWICImagingFactory> factory = Factory();
  if (!factory || png.size() < sizeof(kPngSignature) ||
      png.size() > MAXDWORD ||
      std::memcmp(png.data(), kPngSignature, sizeof(kPngSignature)) != 0) {
    return false;
  }
  ComPtr<IWICStream> stream;
  ComPtr<IWICBitmapDecoder> decoder;
  ComPtr<IWICBitmapFrameDecode> frame;
  ComPtr<IWICFormatConverter> converter;
  UINT width = 0;
  UINT height = 0;
  if (FAILED(factory->CreateStream(&stream)) ||
      FAILED(stream->InitializeFromMemory(const_cast<BYTE*>(png.data()),
                                          static_cast<DWORD>(png.size()))) ||
      FAILED(factory->CreateDecoderFromStream(
          stream.Get(), nullptr, WICDecodeMetadataCacheOnDemand, &decoder)) ||
      FAILED(decoder->GetFrame(0, &frame)) ||
      FAILED(factory->CreateFormatConverter(&converter)) ||
      FAILED(converter->Initialize(frame.Get(), GUID_WICPixelFormat32bppBGRA,
                                   WICBitmapDitherTypeNone, nullptr, 0.0,
                                   WICBitmapPaletteTypeCustom)) ||
      FAILED(converter->GetSize(&width, &height)) || width == 0 ||
      height == 0 || static_cast<uint64_t>(width) * height > kMaxPixels) {
    return false;
  }
  const size_t stride = static_cast<size_t>(width) * 4;
  const size_t rows = height;
  const size_t pixel_bytes = stride * rows;
  Bytes top_down(pixel_bytes);
  if (FAILED(converter->CopyPixels(nullptr, static_cast<UINT>(stride),
                                   static_cast<UINT>(pixel_bytes),
                                   top_down.data()))) {
    return false;
  }
  HGLOBAL dib =
      ::GlobalAlloc(GMEM_MOVEABLE, sizeof(BITMAPV5HEADER) + pixel_bytes);
  HGLOBAL encoded = ::GlobalAlloc(GMEM_MOVEABLE, png.size());
  auto* dib_bytes =
      dib == nullptr ? nullptr : static_cast<uint8_t*>(::GlobalLock(dib));
  auto* png_bytes = encoded == nullptr
                        ? nullptr
                        : static_cast<uint8_t*>(::GlobalLock(encoded));
  if (dib_bytes == nullptr || png_bytes == nullptr) {
    if (dib_bytes != nullptr) ::GlobalUnlock(dib);
    if (png_bytes != nullptr) ::GlobalUnlock(encoded);
    if (dib != nullptr) ::GlobalFree(dib);
    if (encoded != nullptr) ::GlobalFree(encoded);
    return false;
  }
  BITMAPV5HEADER header = {};
  header.bV5Size = sizeof(header);
  header.bV5Width = static_cast<LONG>(width);
  // Bottom-up, as every reader of CF_DIBV5 expects.
  header.bV5Height = static_cast<LONG>(height);
  header.bV5Planes = 1;
  header.bV5BitCount = 32;
  header.bV5Compression = BI_BITFIELDS;
  header.bV5SizeImage = static_cast<DWORD>(pixel_bytes);
  header.bV5RedMask = 0x00FF0000;
  header.bV5GreenMask = 0x0000FF00;
  header.bV5BlueMask = 0x000000FF;
  header.bV5AlphaMask = 0xFF000000;
  header.bV5CSType = LCS_sRGB;
  header.bV5Intent = LCS_GM_IMAGES;
  std::memcpy(dib_bytes, &header, sizeof(header));
  for (size_t y = 0; y < rows; y++) {
    std::memcpy(dib_bytes + sizeof(header) + (rows - 1 - y) * stride,
                top_down.data() + y * stride, stride);
  }
  std::memcpy(png_bytes, png.data(), png.size());
  ::GlobalUnlock(dib);
  ::GlobalUnlock(encoded);
  ClipboardLock lock(owner);
  if (!lock.open() || !::EmptyClipboard()) {
    ::GlobalFree(dib);
    ::GlobalFree(encoded);
    return false;
  }
  // The clipboard owns each handle it accepts.
  const UINT png_format = ::RegisterClipboardFormatW(L"PNG");
  const bool wrote_png =
      png_format != 0 && ::SetClipboardData(png_format, encoded) != nullptr;
  if (!wrote_png) {
    ::GlobalFree(encoded);
  }
  const bool wrote_dib = ::SetClipboardData(CF_DIBV5, dib) != nullptr;
  if (!wrote_dib) {
    ::GlobalFree(dib);
  }
  return wrote_png && wrote_dib;
}

flutter::EncodableValue ReadFilePaths(HWND owner) {
  flutter::EncodableList paths;
  ClipboardLock lock(owner);
  if (lock.open() && ::IsClipboardFormatAvailable(CF_HDROP)) {
    auto drop = static_cast<HDROP>(::GetClipboardData(CF_HDROP));
    if (drop != nullptr) {
      const UINT count = ::DragQueryFileW(drop, 0xFFFFFFFF, nullptr, 0);
      for (UINT i = 0; i < count; i++) {
        const UINT length = ::DragQueryFileW(drop, i, nullptr, 0);
        if (length == 0) {
          continue;
        }
        std::wstring path(static_cast<size_t>(length) + 1, L'\0');
        ::DragQueryFileW(drop, i, path.data(), length + 1);
        path.resize(length);
        paths.emplace_back(Utf8FromUtf16(path.c_str()));
      }
    }
  }
  return flutter::EncodableValue(std::move(paths));
}

}  // namespace

HarnessClipboardImage::HarnessClipboardImage(
    flutter::BinaryMessenger* messenger, HWND owner)
    : owner_(owner) {
  channel_ = std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
      messenger, "harness/clipboard_image",
      &flutter::StandardMethodCodec::GetInstance());
  channel_->SetMethodCallHandler([this](const auto& call, auto result) {
    const std::string& method = call.method_name();
    if (method == "readImagePng") {
      result->Success(ReadImagePng(owner_));
      return;
    }
    if (method == "readFilePaths") {
      result->Success(ReadFilePaths(owner_));
      return;
    }
    if (method == "writeImagePng") {
      const auto* bytes = std::get_if<Bytes>(call.arguments());
      if (bytes == nullptr) {
        result->Error("INVALID_ARGUMENT", "expected PNG bytes");
        return;
      }
      result->Success(flutter::EncodableValue(WriteImagePng(owner_, *bytes)));
      return;
    }
    result->NotImplemented();
  });
}

HarnessClipboardImage::~HarnessClipboardImage() {
  channel_->SetMethodCallHandler(nullptr);
}
