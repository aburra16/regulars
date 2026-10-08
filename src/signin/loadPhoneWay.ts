/**
 * The phone's way of signing in on the sign-in page (./PhoneWay.tsx), with the QR code's library: a
 * chunk of its own. Each call asks for it afresh, so that a fetch that failed (a flaky network, or a
 * deploy that replaced the chunk) is tried again rather than remembered.
 */
export function loadPhoneWay(): Promise<typeof import("./PhoneWay.tsx")> {
  return import("./PhoneWay.tsx");
}
