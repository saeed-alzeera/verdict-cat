import { type Context, type Middleware, type Next } from "@fastr/core";
import { ForbiddenError } from "@fastr/errors";
import { randomString, type SessionState } from "@fastr/middleware-session";
import { User } from "@keybr/database";
import { type AuthState } from "./types.ts";

export function loadUser(): Middleware<SessionState & AuthState> {
  return async (
    ctx: Context<SessionState & AuthState>,
    next: Next,
  ): Promise<void> => {
    const { state } = ctx;
    Object.assign(state, await makeAuthState(state));
    await next();
  };
}

// Offline single-user mode: every visitor is silently bound to the same
// local account so typing progress persists server-side without requiring
// a login flow (email magic links need outbound SMTP, which we don't have).
const LOCAL_USER_EMAIL = "local@keybr.local";

async function makeAuthState(
  state: SessionState & AuthState,
): Promise<AuthState> {
  const { session } = state;
  const userId = session.get("userId");
  let user: User | null = null;
  if (userId != null) {
    user = await User.findById(userId);
  }
  if (user == null) {
    user = await User.login(LOCAL_USER_EMAIL);
    session.start();
    session.set("userId", user.id!);
  }
  const sessionId = session.id ?? randomString(10);
  const publicUser = User.toPublicUser(user, sessionId);
  return {
    sessionId,
    user,
    publicUser,
    requireUser: () => {
      if (user == null) {
        throw new ForbiddenError();
      } else {
        return user;
      }
    },
  };
}
