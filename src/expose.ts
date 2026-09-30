import { $, state } from './core/state';
import { currentRadioQuery } from './features/radio';
import { toast } from './core/dom';
import { navClick, goTab } from './ui/nav';
import { playSong } from './features/player';
import { queueTrackAction, openTrackMenu } from './features/queue';
import {
  addNewTrack, addYouTubeTrack, closeEditModal, saveEditedTrack,
  toggleFavorite, toggleStatsPanel,
} from './features/library';
import {
  goToSearchCategory, playOutsideResult, retryOnlineSearch, runSearchChip,
} from './features/search';
import { renderAuraPicks, resumeLastPlayed, shuffleAll } from './features/home';
import {
  changeProfileName, closeHelp, logoutUser, openHelp, openSettings,
} from './features/settings';
import {
  openAbout, openEffects, openRadioEffectsTab, setRadioSegment, toggleAmbientLayer,
} from './features/ambience';
import { sendBeebooMessage } from './features/beeboo';
import {
  closeRadioSheetThen, loadRadioStations, radioMenuCopy, radioMenuShare,
  radioMenuSite, stopRadio, toggleRadioPlay,
} from './features/radio';

// Inline HTML event handlers (onclick="...") resolve identifiers on the global
// object, so everything they reference must be exposed here.
Object.assign(globalThis, {
  $, state, toast,
  navClick, goTab,
  playSong,
  queueTrackAction, openTrackMenu,
  addNewTrack, addYouTubeTrack, closeEditModal, saveEditedTrack,
  toggleFavorite, toggleStatsPanel,
  goToSearchCategory, playOutsideResult, retryOnlineSearch, runSearchChip,
  renderAuraPicks, resumeLastPlayed, shuffleAll,
  changeProfileName, closeHelp, logoutUser, openHelp, openSettings,
  openAbout, openEffects, openRadioEffectsTab, setRadioSegment, toggleAmbientLayer,
  sendBeebooMessage,
  closeRadioSheetThen, loadRadioStations, radioMenuCopy, radioMenuShare,
  radioMenuSite, stopRadio, toggleRadioPlay,
});

// Read-only accessors for state members referenced from inline handlers.
Object.defineProperty(globalThis, 'songs', { get: () => state.songs, configurable: true });
Object.defineProperty(globalThis, 'currentIndex', { get: () => state.currentIndex, configurable: true });
Object.defineProperty(globalThis, 'currentRadioQuery', { get: () => currentRadioQuery, configurable: true });
