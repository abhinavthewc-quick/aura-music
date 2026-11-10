import { playLoginAnimation, showSignIn } from './ui/login';
import { getSession } from './core/session';

// The HEAD hint controls first paint; this remains the authoritative check.
const session = getSession();
if (session) void playLoginAnimation(session.name || 'Listener', true);
else showSignIn();
