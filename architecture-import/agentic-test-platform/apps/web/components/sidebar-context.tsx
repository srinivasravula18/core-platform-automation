"use client";

import { createContext, useContext } from "react";

/** Lets pages (e.g. the Agent Console) know whether the nav sidebar is collapsed,
 *  so the chat can go full-viewport width when history/nav is hidden. */
export const SidebarCtx = createContext<{ collapsed: boolean }>({ collapsed: false });
export const useSidebar = () => useContext(SidebarCtx);
