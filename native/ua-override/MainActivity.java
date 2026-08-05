package com.hzr.circlemap;

import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

/**
 * 自定义 MainActivity
 *
 * 在 WebView 加载前覆盖 User-Agent，去除移动端标识，
 * 使腾讯地图 JS API v2 认为运行在桌面环境，
 * 从而返回完整的 @1x 瓦片（而非 @nx 高清瓦片）。
 */
public class MainActivity extends BridgeActivity {

    private boolean _uaOverridden = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // 等 WebView 初始化完成后覆盖 UA
        new Handler(Looper.getMainLooper()).post(() -> {
            if (_uaOverridden) return;
            try {
                WebView wv = getBridge().getWebView();
                if (wv != null) {
                    String ua = wv.getSettings().getUserAgentString();
                    ua = ua
                        .replace("Android ", "Linux; ")
                        .replace("Android-", "Linux-")
                        .replace("; wv)", ")")
                        .replace(" Mobile ", " ")
                        .replace("Mobile/", "");
                    wv.getSettings().setUserAgentString(ua);
                    android.util.Log.i("MainActivity", "UA override applied: " + ua.substring(0, 80));
                    _uaOverridden = true;
                }
            } catch (Exception e) {
                android.util.Log.e("MainActivity", "UA override failed", e);
            }
        });
    }
}
