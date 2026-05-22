import type { Page } from "@playwright/test";

export const TEST_USERNAME =
  process.env.TEST_ADMIN_USERNAME || process.env.ADMIN_USERNAME || "admin";
export const TEST_PASSWORD =
  process.env.TEST_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || "admin";

const ACCESS_COOKIE_NAME = "cp_access_token";
const TOKEN_KEY = "core_platform.auth_token";
const CURRENT_USERNAME_KEY = "core_platform.current_username";
const SESSION_TOKEN_MARKER = "session";

const isCookieUsable = (expires: number) =>
  expires < 0 || expires * 1000 > Date.now();

export const hasAccessCookie = async (page: Page, url: string) => {
  const cookies = await page.context().cookies(url);
  return cookies.some(
    (cookie) => cookie.name === ACCESS_COOKIE_NAME && isCookieUsable(cookie.expires)
  );
};

export const installSessionMarker = async (page: Page, username = TEST_USERNAME) => {
  await page.addInitScript(
    ({ currentUsernameKey, tokenKey, tokenValue, usernameValue }) => {
      window.sessionStorage.setItem(tokenKey, tokenValue);
      if (usernameValue) {
        window.sessionStorage.setItem(currentUsernameKey, usernameValue);
      }
    },
    {
      currentUsernameKey: CURRENT_USERNAME_KEY,
      tokenKey: TOKEN_KEY,
      tokenValue: SESSION_TOKEN_MARKER,
      usernameValue: username
    }
  );
};

export const installSessionMarkerFromCookies = async (
  page: Page,
  url: string,
  username = TEST_USERNAME
) => {
  if (!(await hasAccessCookie(page, url))) {
    return false;
  }
  await installSessionMarker(page, username);
  return true;
};

export const maybeSubmitLogin = async (
  page: Page,
  username = TEST_USERNAME,
  password = TEST_PASSWORD,
  timeoutMs = 7_000
) => {
  const loginHeading = page.getByRole("heading", { name: /sign in/i });
  const loginVisible = await loginHeading
    .isVisible({ timeout: timeoutMs })
    .catch(() => false);
  if (!loginVisible) {
    return false;
  }
  if (!username || !password) {
    throw new Error(
      "TEST_ADMIN_USERNAME/TEST_ADMIN_PASSWORD or ADMIN_USERNAME/ADMIN_PASSWORD must be set for login."
    );
  }
  await page.getByLabel(/email or username/i).fill(username);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  return true;
};
