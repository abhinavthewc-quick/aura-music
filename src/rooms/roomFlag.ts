/* Is a listening room currently in charge of playback?
 *
 * Kept in its own dependency-free module on purpose. The player imports this
 * flag, and the room target imports it too — putting it inside either of those
 * would create an import cycle between them, which bundles tolerate but which
 * makes initialisation order matter for no good reason.
 */

let active = false;

export function setRoomActive(value: boolean): void {
  active = value;
}

export function roomModeActive(): boolean {
  return active;
}