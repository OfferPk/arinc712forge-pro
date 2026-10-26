/**
 * ARINC712Forge Pro (v1.0.0) - Core ADF Engine
 * Mark 3 Airborne Automatic Direction Finder (ARINC Characteristic 712 & ICAO Annex 10 Vol I)
 * 
 * Normative References:
 * - ARINC Characteristic 712-7 (Airborne Automatic Direction Finder)
 * - ICAO Annex 10, Volume I (Radio Navigation Aids - Chapter 3.4 Non-Directional Radio Beacon & ADF)
 * - FAA TSO-C41d / EASA ETSO-2C41d (Airborne Automatic Direction Finding Equipment)
 * - RTCA DO-179 (Minimum Operational Performance Standards for Airborne ADF Equipment)
 * - ARINC Specification 429 (Mark 33 Digital Information Transfer System)
 */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ARINC712Engine = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ARINC429_LABELS = {
    ADF_TUNING: 0o032,       // Label 032 - ADF Frequency Tuning Word (BCD)
    ADF_BEARING: 0o162,      // Label 162 - ADF Relative Bearing (BNR)
    ADF_STATUS: 0o270,       // Label 270 - ADF Discrete Status & Operating Mode
    ADF_FAULT: 0o350         // Label 350 - Maintenance & Fault BITE Word
  };

  const ADF_MODES = {
    ADF: 'ADF (Automatic Direction Finding)',
    ANT: 'ANT (Sense Antenna Only - Audio)',
    BFO: 'BFO (Beat Frequency Oscillator Active)',
    LOOP_TEST: 'LOOP_TEST (Goniometer Calibration)'
  };

  const MORSE_MAP = {
    'A': '.-',    'B': '-...',  'C': '-.-.',  'D': '-..',
    'E': '.',     'F': '..-.',  'G': '--.',   'H': '....',
    'I': '..',    'J': '.---',  'K': '-.-',   'L': '.-..',
    'M': '--',    'N': '-.',    'O': '---',   'P': '.--.',
    'Q': '--.-',  'R': '.-.',   'S': '...',   'T': '-',
    'U': '..-',   'V': '...-',  'W': '.--',   'X': '-..-',
    'Y': '-.--',  'Z': '--..'
  };

  /**
   * Helper: Calculate ARINC 429 Bit 32 Odd Parity
   */
  function calculateParity(word31Bits) {
    let count = 0;
    for (let i = 0; i < 31; i++) {
      if ((word31Bits >>> i) & 1) {
        count++;
      }
    }
    return (count % 2 === 0) ? 1 : 0;
  }

  /**
   * Helper: Reverse 8-bit octal label to ARINC 429 transmission order
   */
  function reverseLabelBits(octalLabel) {
    let reversed = 0;
    for (let i = 0; i < 8; i++) {
      reversed = (reversed << 1) | ((octalLabel >> i) & 1);
    }
    return reversed;
  }

  /**
   * Helper: Encode a full ARINC 429 32-bit word with Bit 32 Odd Parity
   */
  function encodeARINC429Word(octalLabel, sdi, dataBits, ssm) {
    const revLabel = reverseLabelBits(octalLabel) & 0xFF;
    const sdiField = (sdi & 0x03) << 8;
    const dataField = (dataBits & 0x7FFFF) << 10;
    const ssmField = (ssm & 0x03) << 29;

    let word = revLabel | sdiField | dataField | ssmField;
    const parity = calculateParity(word);
    word |= (parity << 31);
    return word >>> 0;
  }

  /**
   * Helper: Decode an ARINC 429 32-bit word
   */
  function decodeARINC429Word(word32) {
    const parity = (word32 >>> 31) & 1;
    const wordWithoutParity = word32 & 0x7FFFFFFF;
    const expectedParity = calculateParity(wordWithoutParity);
    const parityValid = (parity === expectedParity);

    const ssm = (word32 >>> 29) & 0x03;
    const data = (word32 >>> 10) & 0x7FFFF;
    const sdi = (word32 >>> 8) & 0x03;
    const rawLabel = word32 & 0xFF;

    let octalLabel = 0;
    for (let i = 0; i < 8; i++) {
      octalLabel = (octalLabel << 1) | ((rawLabel >> i) & 1);
    }

    const ssmMeaning = (ssm === 0x03) ? 'Normal Operation' :
                       (ssm === 0x00) ? 'Failure Warning' :
                       (ssm === 0x01) ? 'No Computed Data (NCD)' : 'Functional Test';

    return {
      wordHex: '0x' + word32.toString(16).toUpperCase().padStart(8, '0'),
      octalLabel: '0' + octalLabel.toString(8).padStart(3, '0'),
      sdi,
      data,
      ssm,
      ssmMeaning,
      parityValid
    };
  }

  /**
   * Helper: Encode Morse Code string at 1020 Hz BFO tone
   */
  function encodeMorse(ident) {
    const clean = ident.toUpperCase().replace(/[^A-Z]/g, '');
    const morseArray = [];
    for (const char of clean) {
      if (MORSE_MAP[char]) {
        morseArray.push(MORSE_MAP[char]);
      }
    }
    return {
      ident: clean,
      morseString: morseArray.join(' '),
      audioToneHz: 1020
    };
  }

  /**
   * ARINC 712 Mark 3 ADF Receiver Class
   */
  class ARINC712Receiver {
    constructor(config = {}) {
      this.unitId = config.unitId || 1; // 1 = ADF 1 (Captain), 2 = ADF 2 (First Officer)
      this.frequencyKhz = config.frequencyKhz || 385.0; // e.g. Dubai NDB 385.0 kHz
      this.stationIdent = config.stationIdent || 'DXB';
      this.relativeBearingDeg = config.relativeBearingDeg !== undefined ? config.relativeBearingDeg : 045.0; // 045 degrees off nose
      this.aircraftHeadingDeg = config.aircraftHeadingDeg !== undefined ? config.aircraftHeadingDeg : 120.0; // Aircraft heading
      this.mode = config.mode || ADF_MODES.ADF;
      this.bfoActive = config.bfoActive || false;
      this.signalStrengthDbm = config.signalStrengthDbm || -70.0;
      this.failWarning = false;

      this.updateCalculations();
    }

    setFrequency(freqKhz) {
      this.frequencyKhz = Math.max(190.0, Math.min(1750.0, parseFloat(freqKhz)));
      this.updateCalculations();
      return this.frequencyKhz;
    }

    setRelativeBearing(rbDeg) {
      this.relativeBearingDeg = (parseFloat(rbDeg) % 360.0 + 360.0) % 360.0;
      this.updateCalculations();
      return this.relativeBearingDeg;
    }

    setAircraftHeading(hdgDeg) {
      this.aircraftHeadingDeg = (parseFloat(hdgDeg) % 360.0 + 360.0) % 360.0;
      this.updateCalculations();
      return this.aircraftHeadingDeg;
    }

    setMode(mode) {
      if (!Object.values(ADF_MODES).includes(mode)) {
        throw new Error(`Invalid ADF Mode: ${mode}`);
      }
      this.mode = mode;
      this.bfoActive = (mode === ADF_MODES.BFO);
      return this.mode;
    }

    updateCalculations() {
      // 1. Magnetic Bearing to Station (QDM):
      // MB = (Relative Bearing + Aircraft Heading) % 360
      this.magneticBearingDeg = (this.relativeBearingDeg + this.aircraftHeadingDeg) % 360.0;

      // 2. Magnetic Bearing from Station (QDR):
      this.bearingFromStationDeg = (this.magneticBearingDeg + 180.0) % 360.0;

      // 3. Crossed-Loop and Sense Antenna Cardioid Math:
      // Loop X: cos(theta), Loop Y: sin(theta)
      const thetaRad = (this.relativeBearingDeg * Math.PI) / 180.0;
      this.antennaVoltages = {
        loopXVolts: parseFloat(Math.cos(thetaRad).toFixed(3)),
        loopYVolts: parseFloat(Math.sin(thetaRad).toFixed(3)),
        senseVolts: 1.0, // Omnidirectional monopole
        cardioidNullRatio: parseFloat((1.0 - Math.cos(thetaRad)).toFixed(3))
      };

      // 4. Morse Code Station Ident
      this.morseIdent = encodeMorse(this.stationIdent);
    }

    /**
     * Encode ARINC 429 Label 032 (ADF Frequency Tuning Word)
     * Format: BCD frequency representation (190.0 to 1750.0 kHz)
     */
    encodeLabel032() {
      // Frequency: e.g. 385.5 kHz -> Hundreds=3, Tens=8, Units=5, Tenths=5
      const freqInt = Math.round(this.frequencyKhz * 10);
      const d1000 = Math.floor(freqInt / 10000) % 10;
      const d100 = Math.floor(freqInt / 1000) % 10;
      const d10 = Math.floor(freqInt / 100) % 10;
      const d1 = Math.floor(freqInt / 10) % 10;
      const d01 = freqInt % 10;

      // Pack into 16-bit BCD data field
      const bcdVal = (d1000 << 12) | (d100 << 8) | (d10 << 4) | (d1);
      const sdi = (this.unitId === 2) ? 2 : 1;
      const ssm = 0x03; // Normal Operation
      return encodeARINC429Word(ARINC429_LABELS.ADF_TUNING, sdi, bcdVal, ssm);
    }

    /**
     * Encode ARINC 429 Label 162 (ADF Relative Bearing)
     * Format: 13-bit BNR binary angle (0 to 359.956 deg, resolution 360/8192 = 0.04395 deg)
     */
    encodeLabel162() {
      // If in ANT mode, bearing pointer is parked (NCD)
      const isAnt = (this.mode === ADF_MODES.ANT);
      const bnrUnits = isAnt ? 0 : (Math.round((this.relativeBearingDeg / 360.0) * 8192) & 0x1FFF);
      const sdi = (this.unitId === 2) ? 2 : 1;
      const ssm = (isAnt || this.failWarning) ? 0x01 : 0x03; // 01=NCD in ANT mode, 03=Normal
      return encodeARINC429Word(ARINC429_LABELS.ADF_BEARING, sdi, bnrUnits, ssm);
    }

    /**
     * Encode ARINC 429 Label 270 (ADF Equipment Status Word)
     */
    encodeLabel270() {
      let statusBits = 0;
      if (this.mode === ADF_MODES.ADF) statusBits |= (1 << 0);
      if (this.mode === ADF_MODES.ANT) statusBits |= (1 << 1);
      if (this.bfoActive) statusBits |= (1 << 2);
      if (this.mode === ADF_MODES.LOOP_TEST) statusBits |= (1 << 3);
      if (this.failWarning) statusBits |= (1 << 4);

      const sdi = (this.unitId === 2) ? 2 : 1;
      const ssm = this.failWarning ? 0x00 : 0x03;
      return encodeARINC429Word(ARINC429_LABELS.ADF_STATUS, sdi, statusBits, ssm);
    }

    /**
     * Encode ARINC 429 Label 350 (ADF Maintenance & Fault Word)
     */
    encodeLabel350() {
      const faultBits = this.failWarning ? 0x01 : 0x00;
      const sdi = (this.unitId === 2) ? 2 : 1;
      const ssm = this.failWarning ? 0x00 : 0x03;
      return encodeARINC429Word(ARINC429_LABELS.ADF_FAULT, sdi, faultBits, ssm);
    }

    getTelemetrySnapshot() {
      const l032 = this.encodeLabel032();
      const l162 = this.encodeLabel162();
      const l270 = this.encodeLabel270();
      const l350 = this.encodeLabel350();

      return {
        timestamp: new Date().toISOString(),
        unitId: `ADF ${this.unitId} (${this.unitId === 1 ? 'Captain' : 'First Officer'})`,
        stationIdent: this.stationIdent,
        morseString: this.morseIdent.morseString,
        frequencyKhz: this.frequencyKhz,
        relativeBearingDeg: this.relativeBearingDeg,
        aircraftHeadingDeg: this.aircraftHeadingDeg,
        magneticBearingDeg: this.magneticBearingDeg,
        bearingFromStationDeg: this.bearingFromStationDeg,
        operationalMode: this.mode,
        bfoActive: this.bfoActive,
        signalStrengthDbm: this.signalStrengthDbm,
        antennaGoniometer: this.antennaVoltages,
        arinc429Words: {
          label032_Tuning: decodeARINC429Word(l032),
          label162_Bearing: decodeARINC429Word(l162),
          label270_Status: decodeARINC429Word(l270),
          label350_Maintenance: decodeARINC429Word(l350)
        }
      };
    }
  }

  return {
    ARINC712Receiver,
    ARINC429_LABELS,
    ADF_MODES,
    calculateParity,
    reverseLabelBits,
    encodeARINC429Word,
    decodeARINC429Word,
    encodeMorse
  };
}));
