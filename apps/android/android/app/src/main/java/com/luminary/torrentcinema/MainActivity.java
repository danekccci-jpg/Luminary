package com.luminary.torrentcinema;

import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TorrServerPlugin.class);
        super.onCreate(savedInstanceState);

        // ── WebView scale fix: приложение должно рендериться 1:1 с экраном ──
        // Без этих настроек Android WebView может использовать «wide viewport»
        // (страница шире экрана) — контент обрезается по краям.
        WebView webView = getBridge().getWebView();
        if (webView != null) {
            webView.getSettings().setUseWideViewPort(false);
            webView.getSettings().setLoadWithOverviewMode(false);
            webView.getSettings().setSupportZoom(false);
            webView.getSettings().setBuiltInZoomControls(false);
            webView.getSettings().setDisplayZoomControls(false);
            webView.setInitialScale(100);
        }
    }
}
