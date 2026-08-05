import { registerPlugin, WebPlugin } from '@capacitor/core';
import type { GnssDataPlugin, GnssSatelliteInfo, GnssNmeaData, GnssStatusEvent } from './definitions';

export type { GnssDataPlugin, GnssSatelliteInfo, GnssNmeaData, GnssStatusEvent };
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
