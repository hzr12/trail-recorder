package com.hzr.circlemap.plugins.gnss;

import com.getcapacitor.JSObject;

/**
 * 单颗卫星的 GNSS 状态数据模型。
 * 映射到 TypeScript 侧 GnssSatelliteInfo 接口。
 */
public class GnssSatelliteInfo {

    private final int svid;
    private final String constellation;
    private final double cn0DbHz;
    private final double elevation;
    private final double azimuth;
    private final boolean usedInFix;
    private final boolean hasEphemeris;
    private final boolean hasAlmanac;

    public GnssSatelliteInfo(int svid, String constellation, double cn0DbHz,
                             double elevation, double azimuth, boolean usedInFix,
                             boolean hasEphemeris, boolean hasAlmanac) {
        this.svid = svid;
        this.constellation = constellation;
        this.cn0DbHz = cn0DbHz;
        this.elevation = elevation;
        this.azimuth = azimuth;
        this.usedInFix = usedInFix;
        this.hasEphemeris = hasEphemeris;
        this.hasAlmanac = hasAlmanac;
    }

    /** 卫星编号 (PRN) */
    public int getSvid() { return svid; }

    /** 星座名称 */
    public String getConstellation() { return constellation; }

    /** 信噪比 dB-Hz */
    public double getCn0DbHz() { return cn0DbHz; }

    /** 仰角 (度) */
    public double getElevation() { return elevation; }

    /** 方位角 (度) */
    public double getAzimuth() { return azimuth; }

    /** 是否参与定位解算 */
    public boolean isUsedInFix() { return usedInFix; }

    /** 是否有星历 */
    public boolean hasEphemeris() { return hasEphemeris; }

    /** 是否有年历 */
    public boolean hasAlmanac() { return hasAlmanac; }

    /**
     * 转为 Capacitor JSObject，桥接到 JavaScript。
     */
    public JSObject toJSObject() {
        JSObject obj = new JSObject();
        obj.put("svid", svid);
        obj.put("constellation", constellation);
        obj.put("cn0DbHz", cn0DbHz);
        obj.put("elevation", elevation);
        obj.put("azimuth", azimuth);
        obj.put("usedInFix", usedInFix);
        obj.put("hasEphemeris", hasEphemeris);
        obj.put("hasAlmanac", hasAlmanac);
        return obj;
    }
}
