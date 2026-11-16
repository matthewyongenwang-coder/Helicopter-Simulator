/**
 * Global physics tuning. Aircraft-specific numbers live in data/aircraft.ts.
 * Everything here is SI unless the name says otherwise.
 */
export const TUNING = {
  /** Fixed physics rate. */
  stepHz: 120,

  atmosphere: {
    rho0: 1.225, // kg/m³ at sea level
    scaleHeight: 8500, // m, exponential density lapse
    /** Engine power available scales with (rho/rho0)^powerLapse. */
    powerLapse: 0.75,
  },

  rotor: {
    liftSlope: 5.73, // per rad
    cd0: 0.0105, // blade profile drag coefficient
    kappa: 1.15, // induced power factor
    /** Blade loading CT/σ at which the blades stall. */
    ctSigmaMax: 0.165,
    /** Blade mass per unit planform area, kg/m². Sets rotor inertia. */
    bladeArealDensity: 24,
    /** Blade pitch servo time constant, s. */
    servoTau: 0.07,
    /** Dynamic inflow time constant, s. */
    inflowTau: 0.14,
    /** Tail rotor + transmission losses as a fraction of main rotor power. */
    tailPowerFraction: 0.09,
    /** Accessory load as a fraction of rated power. */
    accessoryFraction: 0.015,
    /** Static thrust at full collective, as a multiple of max takeoff weight. */
    maxThrustOverMTOW: 1.3,
    /** Flat-pitch blade angle as a fraction of the autorotation pitch at light weight. */
    thetaMinFraction: 0.3,
  },

  groundEffect: {
    /** 1 = textbook Cheeseman–Bennett. */
    strength: 1.0,
    /** Clamp on R/(4z) so the correction stays finite on the ground. */
    maxRatio: 0.47,
  },

  vortexRing: {
    /** Descent rates as multiples of hover induced velocity (negative = down). */
    onsetStart: -0.35,
    onsetFull: -0.75,
    exitStart: -1.35,
    exitEnd: -1.75,
    /** In-plane speed (× hover induced velocity) at which the ring is blown clear. */
    clearStart: 0.45,
    clearEnd: 1.0,
    /** Fraction of thrust lost in a fully developed ring. */
    thrustLoss: 0.5,
    /** Thrust buffet amplitude as a fraction of thrust. */
    buffet: 0.12,
  },

  retreatingBlade: {
    /** Stall onset advance ratio = this × (VNE / tip speed). */
    onsetFactor: 1.04,
    /** Advance-ratio width of the onset ramp. */
    width: 0.07,
    /** Extra onset per unit of CT/σ above nominal loading. */
    loadingGain: 1.6,
    nominalLoading: 0.08,
    thrustLoss: 0.22,
    /** Uncommanded rates at full stall, rad/s (roll toward retreating side, pitch up). */
    rollRate: 0.55,
    pitchRate: 0.3,
  },

  engine: {
    /** Upper bound on start-sequence torque, fraction of rated. The actual limit is derived per aircraft. */
    startTorqueFraction: 0.5,
    /** Rotor RPM band considered "in the green", fraction of nominal. */
    greenMin: 0.95,
    greenMax: 1.05,
    /** Start hands over to the flight governor at this RPM. */
    flyHandover: 0.965,
    governorKp: 9.0, // rated torques per unit RPM error
    governorKi: 6.0,
    /** Max torque as a multiple of rated (transient limit). */
    torqueLimit: 1.2,
    /** Short-term power above the rated figure. Rated power is the 100 % torque mark. */
    transientPower: 1.15,
    /** Seconds of full over-torque the transmission tolerates before it takes damage. */
    overTorqueSeconds: 12,
    overTorqueDamage: 0.012, // health per second once the allowance is used up
    /** RPM above which the rotor overspeeds and takes damage. */
    overspeed: 1.18,
    /** Shaft friction as a fraction of rated torque. */
    friction: 0.006,
    /** Rotor brake torque (fraction of rated), applied below brakeBelow when the engine is off. */
    rotorBrake: 0.05,
    brakeBelow: 0.35,
  },

  yaw: {
    /** Tail rotor sizing: max anti-torque = margin × (rated torque + yaw-rate demand). */
    authorityMargin: 1.25,
    /** Airspeed (m/s) by which the tail rotor has full effectiveness. */
    fullAuthoritySpeed: 15,
    /** Vertical fin: side-force area × lift slope, as a fraction of forward drag area. */
    finFactor: 2.2,
  },

  drag: {
    /** Sideways and vertical flat-plate areas default multipliers of the forward area. */
    rotorHForce: 0.0,
  },

  gear: {
    /** Static deflection as a fraction of stroke at standard mass. */
    staticDeflection: 0.38,
    dampingRatio: 0.55,
    /** Bump-stop stiffness as a multiple of spring stiffness. */
    bottomingFactor: 12,
    friction: 0.75,
    rollingFriction: 0.035,
    /** Tangential stick stiffness as a multiple of vertical stiffness. */
    stickFactor: 2.0,
  },

  hull: {
    /** Penalty stiffness: natural frequency of the hull against a hard surface, rad/s. */
    contactOmega: 26,
    dampingRatio: 0.7,
    friction: 0.6,
    /** Normal impact speed below which hull contact does no damage, m/s. */
    scuffSpeed: 0.8,
  },

  water: {
    /** Buoyancy stiffness in g per metre of immersion, per contact point share. */
    buoyancy: 1.6,
    drag: 2.5,
    /** Hull immersion (m) at which the aircraft is lost. */
    ditchDepth: 0.6,
  },

  damage: {
    /** Health below which engine power starts to fall. */
    powerLossBelow: 0.6,
    /** Health below which the engine fails. */
    engineFailBelow: 0.22,
    /** Tail contact speed that takes out the tail rotor, m/s. */
    tailStrikeSpeed: 2.2,
  },

  gust: {
    /** Angular acceleration per m/s of vertical-wind difference across the disc, rad/s² per m/s. */
    momentGain: 0.5,
  },

  autohover: {
    /** Speed below which braking hands over to position hold, m/s. */
    captureSpeed: 0.6,
    captureVerticalSpeed: 0.4,
    captureYawRate: 0.08, // rad/s
    /** Loop bandwidth ratios, outer/inner. */
    velocityToAttitude: 0.36,
    positionToVelocity: 0.4,
    /** Rate-loop lead: commanded rate = wanted + lead × (wanted − actual). */
    rateLead: 4.0,
    attitudeGainFactor: 0.5, // k_att = factor / effective tau
    maxAttitudeGain: 15, // 1/s
    /** Vertical loop. */
    verticalGain: 3.2, // 1/s, vertical speed error → acceleration
    altitudeGain: 1.3, // 1/s
    maxVerticalSpeed: 8, // m/s
    maxVerticalAccel: 0.65, // g
    thrustIntegral: 0.9, // 1/s
    /** Collective lever slew under autohover, fraction per second. */
    leverRate: 2.6,
    /** Yaw loop. */
    headingGain: 3.0, // 1/s
    trimTau: 0.25, // s, pedal trim follows measured torque
    /** Wind integrator, (m/s²) per (m/s) per second. */
    windIntegral: 0.55,
    maxWindAccel: 4.5,
    /** Fraction of estimated max thrust the controller will plan on. */
    thrustReserve: 0.95,
    /** Engine power the controller budgets for, × available: normally, and once RPM has drooped. */
    powerTransient: 1.13,
    powerDrooped: 1.0,
    /** Further power given back as RPM falls from 95.5 % to 92.5 %. */
    droopBackoff: 0.3,
    /** Lean (deg) a held cyclic key can reach while autohover is on. */
    pilotTiltLimit: 32,
    /** Once active, autohover stays in control down to this rotor RPM. */
    dropoutRpm: 0.86,
    /** Vortex-ring protection: sink rates (× hover induced velocity) over which it keeps airspeed on. */
    escapeSinkStart: 0.3,
    escapeSinkFull: 0.55,
    /** While sinking, braking lean is cut back until the predicted vortex-ring factor is under this. */
    maxBrakeRing: 0.2,
    minBrakeTilt: 6, // deg
    /** Airspeed held while escaping, × hover induced velocity. */
    escapeSpeed: 1.3,
  },
} as const;

export type Tuning = typeof TUNING;
