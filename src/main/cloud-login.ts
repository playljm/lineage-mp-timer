/**
 * Cloud login popup — extracts a session token from a hosted login page.
 *
 * A modal {@link BrowserWindow} loads the pinned login URL and watches its
 * isolated session for a `session_token` (or `auth_token`/`token`) cookie. The
 * login host is hardcoded here: the renderer must NOT be able to point this popup
 * at an arbitrary origin (that would turn it into a credential-phishing surface),
 * so any caller-supplied URL is ignored.
 *
 * The popup uses a persistent partition so the user stays logged in across runs,
 * and a sandboxed, isolated web context (it loads untrusted remote content).
 */

import { BrowserWindow, session } from 'electron'
import type { CloudLoginResult } from '@shared/ipc-contract'
import { getMainWindow } from './windows'

/** Pinned login origin — never overridden by renderer input. */
const LOGIN_URL = 'https://ramin-5gt.pages.dev/login.html'
const BASE_HOST = 'ramin-5gt.pages.dev'
const PARTITION = 'persist:cloud-login'

const TOKEN_COOKIE_NAMES = ['session_token', 'auth_token', 'token']
const EMAIL_COOKIE_NAMES = ['user_email', 'email']

let loginWindow: BrowserWindow | null = null

/**
 * Open the login popup and resolve once a session token is observed (or the
 * window is closed without one).
 *
 * Only one popup may be open at a time; a second call while one is open focuses
 * the existing window and resolves to a null result.
 *
 * @returns `{ token, email }`; either field is null when unavailable.
 */
export async function cloudLoginPopup(): Promise<CloudLoginResult> {
  if (loginWindow && !loginWindow.isDestroyed()) {
    try {
      loginWindow.focus()
    } catch {
      /* ignore */
    }
    return { token: null, email: null }
  }

  const parent = getMainWindow() ?? undefined

  return new Promise<CloudLoginResult>((resolve) => {
    let settled = false

    const win = new BrowserWindow({
      width: 480,
      height: 640,
      title: 'Cloud Login',
      parent,
      modal: !!parent,
      backgroundColor: '#0a0f0a',
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: PARTITION
      }
    })
    win.setMenu(null)
    loginWindow = win

    const settle = (value: CloudLoginResult): void => {
      if (settled) return
      settled = true
      if (!win.isDestroyed()) {
        try {
          win.close()
        } catch {
          /* ignore */
        }
      }
      loginWindow = null
      resolve(value)
    }

    const ses = win.webContents.session
    const tryExtractToken = async (): Promise<void> => {
      try {
        const cookies = await ses.cookies.get({ domain: BASE_HOST })
        const token = cookies.find((c) => TOKEN_COOKIE_NAMES.includes(c.name))?.value
        if (token) {
          const email = cookies.find((c) => EMAIL_COOKIE_NAMES.includes(c.name))?.value ?? null
          settle({ token, email })
        }
      } catch {
        /* try again on the next navigation */
      }
    }

    win.webContents.on('did-navigate', () => void tryExtractToken())
    win.webContents.on('did-navigate-in-page', () => void tryExtractToken())
    win.webContents.on('did-finish-load', () => void tryExtractToken())
    win.on('closed', () => {
      loginWindow = null
      settle({ token: null, email: null })
    })

    void win.loadURL(LOGIN_URL)
  })
}

/** Clear stored login cookies so the next popup starts fresh. */
export async function clearCloudCookies(): Promise<void> {
  try {
    const ses = session.fromPartition(PARTITION)
    const cookies = await ses.cookies.get({ domain: BASE_HOST })
    for (const c of cookies) {
      const host = (c.domain ?? BASE_HOST).replace(/^\./, '')
      const url = `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`
      try {
        await ses.cookies.remove(url, c.name)
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}
