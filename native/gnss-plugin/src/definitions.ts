export interface GnssSatelliteInfo {
  /** 卫星编号 (PRN/SVID) */
  svid: number;
  /** 星座: "GPS" | "GLONASS" | "BEIDOU" | "GALILEO" | "SBAS" | "QZSS" | "IRNSS" | "UNKNOWN" */
  constellation: string;
  /** 信噪比 dB-Hz (0~60+, 越高信号越好) */
  cn0DbHz: number;
  /** 仰角 (度) */
  elevation: number;
  /** 方位角 (度) */
  azimuth: number;
  /** 是否参与当前定位解算 */
  usedInFix: boolean;
  /** 是否有星历数据 */
  hasEphemeris: boolean;
  /** 是否有年历数据 */
  hasAlmanac: boolean;
}

export interface GnssNmeaData {
  /** 时间戳 (nanosecond) */
  timestamp: number;
  /** 原始 NMEA 语句, 如 "$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47" */
  sentence: string;
}

export interface GnssStatusEvent {
  satellites: GnssSatelliteInfo[];
}

export interface GnssDataPlugin {
  /**
   * 开始监听 GNSS 原始数据（卫星状态 + NMEA）。
   * 需要 ACCESS_FINE_LOCATION 权限。
   */
  startGnssListening(): Promise<void>;

  /**
   * 停止监听，释放资源。
   */
  stopGnssListening(): Promise<void>;

  /**
   * 获取最后一次缓存的卫星和 NMEA 数据快照。
   */
  getLastGnssData(): Promise<{
    satellites: GnssSatelliteInfo[];
    nmea: GnssNmeaData[];
  }>;
}
