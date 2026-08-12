import "@testing-library/jest-dom/vitest";
import { Blob as NodeBlob } from "node:buffer";

// jsdom's Blob lacks the standard text()/arrayBuffer() methods under Node 26.
// Use Node's web-compatible implementation in tests, matching browser behavior.
Object.defineProperty(globalThis, "Blob", {
    configurable: true,
    writable: true,
    value: NodeBlob,
});
