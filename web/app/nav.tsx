"use client";

import { usePathname } from "next/navigation";
import { NavLinks } from "./nav-links";

/** The main navigation, told which page it is on. */
export function Nav() {
  return <NavLinks pathname={usePathname()} />;
}
