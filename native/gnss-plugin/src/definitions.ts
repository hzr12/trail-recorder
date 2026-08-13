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

export interface ImuSample {
  /** 设备系线性加速度 X（m/s²，TYPE_LINEAR_ACCELERATION 已去重力） */
  ax: number;
  /** 设备系线性加速度 Y（m/s²） */
  ay: number;
  /** 设备系线性加速度 Z（m/s²） */
  az: number;
  /** 陀螺仪角速度 X（rad/s） */
  gx: number;
  /** 陀螺仪角速度 Y（rad/s） */
  gy: number;
  /** 陀螺仪角速度 Z（rad/s） */
  gz: number;
  /** 姿态四元数 [w,x,y,z]（设备系→ENU 世界系）；无姿态数据时为 [] */
  rotation: number[];
  /**
   * 姿态四元数对应的传感器事件时间戳（nanosecond，与 timestamp 同源时钟）。
   * rotation 与线性加速度来自不同传感器（异步到达），JS 侧用该字段做
   * 姿态-加速度时间对齐：旋转加速度时按加速度事件时间戳查询最近姿态。
   * 旧插件未下发时为 0，JS 侧退化为使用加速度自身时间戳（与旧行为等价）。
   */
  rotationTs: number;
  /** 传感器时间戳（nanosecond） */
  timestamp: number;
}

export interface ImuDataPlugin {
  /**
   * 开始监听 IMU 传感器（线性加速度 + 陀螺仪 + 旋转向量，10Hz）。
   * 惯性传感器无需权限。
   */
  startImuListening(): Promise<void>;

  /**
   * 停止监听，释放传感器。
   */
  stopImuListening(): Promise<void>;

  /**
   * 获取最后一次缓存的 IMU 样本快照（事件流中断时兜底）。
   */
  getLastImuSample(): Promise<ImuSample>;
}
