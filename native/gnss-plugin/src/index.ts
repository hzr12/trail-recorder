import { registerPlugin, WebPlugin } from '@capacitor/core';
import type { GnssDataPlugin, GnssSatelliteInfo, GnssNmeaData, GnssStatusEvent, ImuDataPlugin, ImuSample } from './definitions';

export type { GnssDataPlugin, GnssSatelliteInfo, GnssNmeaData, GnssStatusEvent, ImuDataPlugin, ImuSample };
export * from './definitions';

/**
 * Web platform stub — 浏览器拿不到 GNSS 原始数据。
 * 在 Android 原生端会覆盖此实现。
 */
class GnssDataWeb extends WebPlugin implements GnssDataPlugin {
  async startGnssListening(): Promise<void> {
    console.warn('[GnssData] GNSS raw data not available on web platform');
  }

  async stopGnssListening(): Promise<void> {
    // no-op
  }

  async getLastGnssData(): Promise<{
    satellites: GnssSatelliteInfo[];
    nmea: GnssNmeaData[];
  }> {
    return { satellites: [], nmea: [] };
  }
}

const GnssData = registerPlugin<GnssDataPlugin>('GnssData', {
  web: () => new GnssDataWeb(),
});

export { GnssData };

/**
 * Web platform stub — 浏览器拿不到惯性传感器数据。
 * 在 Android 原生端会覆盖此实现。
 */
class ImuDataWeb extends WebPlugin implements ImuDataPlugin {
  async startImuListening(): Promise<void> {
    console.warn('[ImuData] IMU not available on web platform');
  }

  async stopImuListening(): Promise<void> {
    // no-op
  }

  async getLastImuSample(): Promise<ImuSample> {
    return { ax: 0, ay: 0, az: 0, gx: 0, gy: 0, gz: 0, rotation: [], rotationTs: 0, timestamp: 0 };
  }
}

const ImuData = registerPlugin<ImuDataPlugin>('ImuData', {
  web: () => new ImuDataWeb(),
});

export { ImuData };
