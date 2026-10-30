import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/terminal/terminal_links.dart';

void main() {
  test('a video is told from a picture by the list links are found with', () {
    for (final video in [
      'clip.mp4',
      'clip.m4v',
      '/work/Screen Recording.MOV',
      '~/out/demo.webm',
      'take.mkv',
      'take.avi',
      'take.mpg',
      'take.mpeg',
      'take.ogv',
      'take.3gp',
    ]) {
      expect(isVideoPath(video), isTrue, reason: video);
      expect(isMediaPath(video), isTrue, reason: video);
    }
    for (final picture in [
      'shot.png',
      'shot.JPG',
      'shot.jpeg',
      'loop.gif',
      'shot.webp',
      'shot.avif',
      'IMG_0001.HEIC',
      'shot.heif',
      'shot.bmp',
      'scan.tif',
      'scan.tiff',
      'diagram.svg',
      'favicon.ico',
    ]) {
      expect(isVideoPath(picture), isFalse, reason: picture);
      expect(isMediaPath(picture), isTrue, reason: picture);
    }
    for (final other in ['notes.txt', 'mp4', 'clip.mp4.txt', 'movie']) {
      expect(isVideoPath(other), isFalse, reason: other);
      expect(isMediaPath(other), isFalse, reason: other);
    }
  });
}
