// Brings jest-dom's matchers into the type-checked program. src/test/setup.ts registers them at
// runtime, but tsconfig excludes src/test/, so tsc never saw that import.
import '@testing-library/jest-dom/vitest'
