import { copy } from "./copy/en.ts";

/** Placeholder shell. The router, data providers and screens arrive in later tasks. */
export function App() {
  return (
    <main className="p-5">
      <p className="font-display text-display-phone font-extrabold tracking-display text-ink">
        {copy.app.name}
      </p>
    </main>
  );
}
