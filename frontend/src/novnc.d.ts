// Minimal type declaration for the noVNC package (it ships no types).
// The package's `exports` field maps the package root ("@novnc/novnc")
// to ./core/rfb.js, so we import the default from the root, not a deep path.
declare module "@novnc/novnc" {
  export interface RfbInstance {
    disconnect(): void;
    sendCredentials(c: { password: string }): void;
    scaleViewport: boolean;
    addEventListener(
      event: string,
      cb: (ev: { detail: { password?: boolean } }) => void
    ): void;
  }
  interface RfbConstructor {
    new (
      target: HTMLElement,
      url: string,
      opts?: Record<string, unknown>
    ): RfbInstance;
  }
  const RFB: RfbConstructor;
  export default RFB;
}
