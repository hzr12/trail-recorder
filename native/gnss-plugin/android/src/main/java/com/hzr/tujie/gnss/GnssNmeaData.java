package com.hzr.tujie.plugins.gnss;

import com.getcapacitor.JSObject;

/**
 * 单条 NMEA 语句数据模型�?
 * 映射�?TypeScript �?GnssNmeaData 接口�?
 */
public class GnssNmeaData {

    private final long timestamp;
    private final String sentence;

    public GnssNmeaData(long timestamp, String sentence) {
        this.timestamp = timestamp;
        this.sentence = sentence;
    }

    /** NMEA 时间�?(nanosecond) */
    public long getTimestamp() { return timestamp; }

    /** 原始 NMEA 语句文本 */
    public String getSentence() { return sentence; }

    /**
     * 转为 Capacitor JSObject，桥接到 JavaScript�?
     */
    public JSObject toJSObject() {
        JSObject obj = new JSObject();
        obj.put("timestamp", timestamp);
        obj.put("sentence", sentence);
        return obj;
    }
}
