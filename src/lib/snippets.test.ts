import { describe, expect, it } from "vitest";
import { expandSnippet, matchSnippets, snippetTrigger } from "./snippets";

describe("snippetTrigger", () => {
  it("finds ;query at the caret when ; starts a word", () => {
    expect(snippetTrigger(";th", 3)).toEqual({ start: 0, query: "th" });
    expect(snippetTrigger("Hi Sam,\n\n;tha", 13)).toEqual({ start: 9, query: "tha" });
    expect(snippetTrigger("ok ;", 4)).toEqual({ start: 3, query: "" });
  });

  it("ignores ordinary semicolons and finished words", () => {
    expect(snippetTrigger("a;b", 3)).toBeNull(); // mid-word
    expect(snippetTrigger(";thanks done", 12)).toBeNull(); // caret past a space
    expect(snippetTrigger("x ;thanks", 5)).toEqual({ start: 2, query: "th" }); // caret mid-query
  });
});

describe("matchSnippets", () => {
  const s = [
    { name: "thanks", body: "Thanks!" },
    { name: "intro", body: "Meet my colleague" },
    { name: "follow-up", body: "Just checking in, thanks" },
    { name: "bothanks", body: "x" },
  ];
  it("ranks name prefix, then name contains, then body", () => {
    expect(matchSnippets(s, "th").map((x) => x.name)).toEqual(["thanks", "bothanks", "follow-up"]);
    expect(matchSnippets(s, "INT").map((x) => x.name)).toEqual(["intro"]);
    expect(matchSnippets(s, "")).toHaveLength(4);
    expect(matchSnippets(s, "zzz")).toEqual([]);
  });
});

describe("expandSnippet", () => {
  const me = { name: "Boris Peet", address: "boris@peetmail.test" };
  it("fills recipient and sender names", () => {
    expect(expandSnippet("Hi {first_name}, {name}. Cheers, {my_first_name} ({my_name})", { to: { name: "Priya Nair", address: "priya@x.io" }, me })).toBe(
      "Hi Priya, Priya Nair. Cheers, Boris (Boris Peet)",
    );
  });

  it("guesses a name from the address, and handles 'Last, First'", () => {
    expect(expandSnippet("Hi {first_name} / {name}", { to: { name: null, address: "jordan.lee@contoso.com" }, me })).toBe("Hi Jordan / Jordan Lee");
    expect(expandSnippet("Hi {first_name}", { to: { name: "Nair, Priya", address: "p@x" }, me })).toBe("Hi Priya");
  });

  it("blank without a recipient; unknown placeholders stay", () => {
    expect(expandSnippet("Hi {first_name}, see {link}", { to: null, me })).toBe("Hi , see {link}");
  });
});
