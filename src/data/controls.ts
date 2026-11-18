/** Every bindable action. Flight actions are consumed by the pure sim; the rest by the game shell. */
export type FlightAction =
  | 'engineToggle'
  | 'autohoverToggle'
  | 'collectiveUp'
  | 'collectiveDown'
  | 'pitchDown'
  | 'pitchUp'
  | 'rollLeft'
  | 'rollRight'
  | 'yawLeft'
  | 'yawRight'
  | 'wheelBrake';

export type GameAction =
  | 'cameraNext'
  | 'freeLook'
  | 'toggleControls'
  | 'toggleMap'
  | 'landingLight'
  | 'respawn'
  | 'pause'
  | 'fireGun'
  | 'fireMissile'
  | 'flares';

export type Action = FlightAction | GameAction;

/** Default bindings as KeyboardEvent.code values. Each action may have several keys. */
export const DEFAULT_BINDINGS: Record<Action, string[]> = {
  engineToggle: ['KeyJ'],
  autohoverToggle: ['KeyX'],
  collectiveUp: ['Space'],
  collectiveDown: ['ShiftLeft', 'ShiftRight'],
  pitchDown: ['KeyW'],
  pitchUp: ['KeyS'],
  rollLeft: ['KeyA'],
  rollRight: ['KeyD'],
  yawLeft: ['KeyQ'],
  yawRight: ['KeyE'],
  wheelBrake: ['KeyB'],
  cameraNext: ['KeyC'],
  freeLook: ['KeyV'],
  toggleControls: ['KeyH', 'F1'],
  toggleMap: ['KeyM'],
  landingLight: ['KeyL'],
  respawn: ['KeyR'],
  pause: ['Escape', 'KeyP'],
  fireGun: ['KeyF'],
  fireMissile: ['KeyG'],
  flares: ['KeyK'],
};

export const ACTION_LABELS: Record<Action, string> = {
  engineToggle: 'Engine start / stop',
  autohoverToggle: 'Autohover',
  collectiveUp: 'Collective up',
  collectiveDown: 'Collective down',
  pitchDown: 'Pitch nose down',
  pitchUp: 'Pitch nose up',
  rollLeft: 'Roll left',
  rollRight: 'Roll right',
  yawLeft: 'Yaw left',
  yawRight: 'Yaw right',
  wheelBrake: 'Wheel brake',
  cameraNext: 'Next camera',
  freeLook: 'Centre view',
  toggleControls: 'Controls overlay',
  toggleMap: 'Minimap zoom',
  landingLight: 'Landing light',
  respawn: 'Respawn at last helipad',
  pause: 'Pause / menu',
  fireGun: 'Fire gun (or left click)',
  fireMissile: 'Fire missile (or right click)',
  flares: 'Release flares',
};

/** Actions that fire once per key press instead of being held. */
export const TOGGLE_ACTIONS: ReadonlySet<Action> = new Set<Action>([
  'engineToggle',
  'autohoverToggle',
  'wheelBrake',
  'cameraNext',
  'freeLook',
  'toggleControls',
  'toggleMap',
  'landingLight',
  'respawn',
  'pause',
  'fireMissile',
  'flares',
]);
