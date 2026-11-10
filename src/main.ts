import { playLoginAnimation } from './ui/login';
import { getSession } from './core/session';

const session = getSession();
if (session) void playLoginAnimation(session.name || 'Listener');
