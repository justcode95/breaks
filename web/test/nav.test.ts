import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { isCurrent, NavLinks } from "../app/nav-links";

const nav = (pathname: string) => renderToStaticMarkup(createElement(NavLinks, { pathname }));
/** The labels of the links marked as the current page. */
const marked = (html: string) => [...html.matchAll(/<a [^>]*aria-current="page"[^>]*>(.*?)<\/a>/g)].map((m) => m[1]);

describe("which page the navigation marks", () => {
  it("is a page and the pages below it, and nothing that only starts with the same letters", () => {
    expect(isCurrent("/breaks", "/breaks")).toBe(true);
    expect(isCurrent("/breaks/7", "/breaks")).toBe(true);
    expect(isCurrent("/breaksy", "/breaks")).toBe(false);
    expect(isCurrent("/treasury", "/breaks")).toBe(false);
    expect(isCurrent("/menu", "/me")).toBe(false);
    expect(isCurrent("/how-it-works", "/how")).toBe(false);
    expect(isCurrent("/", "/breaks")).toBe(false);
  });

  it("marks the one link of the page you are on", () => {
    expect(marked(nav("/breaks"))).toEqual(["Breaks"]);
    expect(marked(nav("/breaks/12"))).toEqual(["Breaks"]);
    expect(marked(nav("/treasury"))).toEqual(["Treasury"]);
    expect(marked(nav("/how-it-works"))).toEqual(["How it works"]);
    expect(marked(nav("/me"))).toEqual(["My spots"]);
    expect(marked(nav("/verify"))).toEqual(["Verify a draw"]);
  });

  it("marks nothing on the home page or on a page that is not in the navigation", () => {
    expect(marked(nav("/"))).toEqual([]);
    expect(marked(nav("/somewhere-else"))).toEqual([]);
  });

  it("is a labelled navigation with the five links, in order", () => {
    const html = nav("/");
    expect(html).toContain('<nav aria-label="Main">');
    expect([...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])).toEqual(["/how-it-works", "/breaks", "/treasury", "/me", "/verify"]);
  });
});
