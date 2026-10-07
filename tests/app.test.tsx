import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "../src/App";
import { copy } from "../src/copy/en";

describe("App", () => {
  it("shows the Regulars wordmark", () => {
    render(<App />);
    expect(screen.getByText(copy.app.name)).toBeInTheDocument();
  });
});
