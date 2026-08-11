package com.luminary.torrentcinema;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Capacitor plugin для запуска TorrServer (Go-бинарник) на Android.
 *
 * Бинарник лежит в APK assets/torrserver/TorrServer-android-arm64.
 * При первом запуске извлекается в context.getFilesDir()/torrserver/.
 * Запускается как foreground service (.Notification) для стабильности.
 */
@CapacitorPlugin(name = "TorrServer")
public class TorrServerPlugin extends Plugin {

    private static final String TAG = "TorrServerPlugin";
    private static final String CHANNEL_ID = "torrserver_channel";
    private static final String BINARY_NAME = "TorrServer-android-arm64";
    private static final int NOTIFICATION_ID = 9001;
    private static final int PORT = 8090;

    private Process process;
    private int pid = -1;

    // ── Lifecycle ──

    @Override
    public void load() {
        createNotificationChannel();
        // Проверяем, запущен ли уже TorrServer (при перезагрузке WebView)
        if (isProcessRunning()) {
            Log.i(TAG, "TorrServer already running (pid=" + pid + ")");
        }
    }

    @Override
    protected void handleOnDestroy() {
        stopServer();
        super.handleOnDestroy();
    }

    // ── Plugin Methods ──

    @PluginMethod
    public void start(PluginCall call) {
        if (isProcessRunning()) {
            call.resolve(makeResult(true, "already running"));
            return;
        }

        try {
            File binary = extractBinary();
            if (binary == null) {
                call.reject("Failed to extract TorrServer binary");
                return;
            }

            startForeground();
            runBinary(binary);
            call.resolve(makeResult(true, "started"));
        } catch (Exception e) {
            Log.e(TAG, "start failed", e);
            call.reject("Start failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopServer();
        call.resolve(makeResult(false, "stopped"));
    }

    @PluginMethod
    public void isRunning(PluginCall call) {
        JSObject r = new JSObject();
        r.put("running", isProcessRunning());
        r.put("pid", pid);
        r.put("port", PORT);
        call.resolve(r);
    }

    @PluginMethod
    public void getPort(PluginCall call) {
        JSObject r = new JSObject();
        r.put("port", PORT);
        call.resolve(r);
    }

    // ── Binary Extraction ──

    private File extractBinary() {
        File targetDir = new File(getContext().getFilesDir(), "torrserver");
        File target = new File(targetDir, BINARY_NAME);

        // Если уже извлечён — пропускаем
        if (target.exists() && target.length() > 1_000_000) {
            setExecutable(target);
            return target;
        }

        targetDir.mkdirs();

        try {
            // Копируем из assets
            try (InputStream in = getContext().getAssets().open("torrserver/" + BINARY_NAME);
                 OutputStream out = new FileOutputStream(target)) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) != -1) {
                    out.write(buf, 0, n);
                }
            }
            setExecutable(target);
            Log.i(TAG, "Binary extracted: " + target.getAbsolutePath() + " (" + target.length() + " bytes)");
            return target;
        } catch (Exception e) {
            Log.e(TAG, "extractBinary failed", e);
            return null;
        }
    }

    private void setExecutable(File f) {
        f.setExecutable(true, false);
        f.setReadable(true, false);
    }

    // ── Process Management ──

    private void runBinary(File binary) {
        try {
            ProcessBuilder pb = new ProcessBuilder(
                binary.getAbsolutePath(),
                "--port", String.valueOf(PORT),
                "--ip", "0.0.0.0",
                "--path", new File(getContext().getFilesDir(), "torrserver_data").getAbsolutePath()
            );
            pb.directory(binary.getParentFile());
            pb.redirectErrorStream(true);
            process = pb.start();
            pid = getProcessPid(process);
            Log.i(TAG, "TorrServer started, pid=" + pid);

            // Читаем stdout в фоне (чтобы процесс не завис)
            new Thread(() -> {
                try {
                    InputStream is = process.getInputStream();
                    byte[] buf = new byte[1024];
                    while (is.read(buf) != -1) { /* drain */ }
                } catch (Exception ignored) {}
            }).start();
        } catch (Exception e) {
            Log.e(TAG, "runBinary failed", e);
        }
    }

    private void stopServer() {
        if (process != null) {
            process.destroy();
            try { process.waitFor(); } catch (Exception ignored) {}
            process = null;
            pid = -1;
            Log.i(TAG, "TorrServer stopped");
        }
        stopForeground();
    }

    private boolean isProcessRunning() {
        if (process == null) return false;
        try {
            process.exitValue(); // если не бросил — процесс жив
            return false;
        } catch (IllegalThreadStateException e) {
            return true; // процесс ещё работает
        }
    }

    private int getProcessPid(Process p) {
        try {
            // Process.pid() доступен с API 26
            return (int) p.getClass().getMethod("pid").invoke(p);
        } catch (Exception e) {
            return -1;
        }
    }

    // ── Foreground Service (Notification) ──

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "TorrServer", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("TorrServer streaming service");
            NotificationManager nm = getContext().getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }

    private void startForeground() {
        Intent intent = new Intent(getContext(), MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(getContext(), 0, intent, PendingIntent.FLAG_IMMUTABLE);

        Notification notification = new NotificationCompat.Builder(getContext(), CHANNEL_ID)
            .setContentTitle("Luminary")
            .setContentText("TorrServer работает")
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentIntent(pi)
            .setOngoing(true)
            .build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Android 14+: нужен foreground service type
            getContext().startForegroundService(new Intent(getContext(), TorrServerService.class));
        }

        // Используем Activity для startForeground (проще, чем отдельный Service)
        if (getActivity() != null) {
            getActivity().startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void stopForeground() {
        if (getActivity() != null) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                getActivity().stopForeground(true);
            }
        }
    }

    private JSObject makeResult(boolean running, String message) {
        JSObject r = new JSObject();
        r.put("running", running);
        r.put("message", message);
        r.put("pid", pid);
        r.put("port", PORT);
        return r;
    }
}
