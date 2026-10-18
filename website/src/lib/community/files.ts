import type { SourceFile } from './types';

const encoder = new TextEncoder();

/** The bytes `text` takes as UTF-8. */
export const textBytes = (text: string) => encoder.encode(text).length;

/** A file's size on disk: base64 holds three bytes in every four characters. */
export const diskBytes = (file: SourceFile) => file.encoding ? Math.floor(file.content.length * 3 / 4) : textBytes(file.content);

/** A file's size as the Hub receives and limits it: its text, base64 included. */
export const sentBytes = (file: SourceFile) => textBytes(file.content);

export const formatBytes = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${Math.ceil(bytes / 1024)} KB`;
