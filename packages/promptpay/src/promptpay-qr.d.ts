// Reference implementation used only by tests (devDependency, no bundled types).
declare module 'promptpay-qr' {
  export default function generatePayload(target: string, options: { amount?: number }): string;
}
