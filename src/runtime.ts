import './styles/main.css';
import './styles/icons.css';
import './ui/loader';
import './expose';
import './ui/mini-player';
import './ui/marquee';
import './features/playlists';
import './ui/a11y';
import './features/presence-reporter';
import { installCoverFallback } from './core/dom';

installCoverFallback();
export { ready } from './app';
