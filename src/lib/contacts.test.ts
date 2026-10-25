import { describe, expect, it } from "vitest";
import { narrow } from "./contacts";

const receipts = { name: null, address: "receipts@stripe.com" };
const priya = { name: "Priya Nair", address: "priya@fabrikam.io" };

describe("narrow", () => {
  it("drops suggestions from a shorter prefix that no longer match", () => {
    // List shown for "p" while the lookup for "priya" is still running.
    expect(narrow([receipts, priya], "priya")).toEqual([priya]);
  });

  it("matches names and addresses case-insensitively", () => {
    expect(narrow([receipts, priya], "NAIR")).toEqual([priya]);
    expect(narrow([receipts, priya], "stripe")).toEqual([receipts]);
    expect(narrow([receipts, priya], "")).toEqual([receipts, priya]);
  });
});
