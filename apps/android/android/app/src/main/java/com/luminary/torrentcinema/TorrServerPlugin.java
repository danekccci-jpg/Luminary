package com.luminary.torrentcinema;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;

/**
 * Capacitor plugin для запуска TorrServer (Go-бинарник) на Android.
 *
 * TorrServer упакован как native library (libtorrserver.so) в APK.
 * Android автоматически извлекает его в nativeLibraryDir при установке:
 *   /data/app/<package>/lib/arm64/libtorrserver.so
 *
 * Это позволяет обойти ограничение Android 10+ (W^X): нельзя выполнять
 * бинарники из /data/data/*/files/, но МОЖНО из nativeLibraryDir.
 */
@CapacitorPlugin(name = "TorrServer")
public class TorrServerPlugin extends Plugin {

    private static final String TAG = "TorrServerPlugin";
    private static final String CHANNEL_ID = "torrserver_channel";
    private static final String LIB_NAME = "libtorrserver.so";
    private static final int NOTIFICATION_ID = 9001;
    private static final int PORT = 8090;

    private Process process;
    private int pid = -1;

    @Override
    public void load() {
        createNotificationChannel();
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
            File binary = getNativeBinary();
            if (binary == null || !binary.exists()) {
                String nativeDir = getContext().getApplicationInfo().nativeLibraryDir;
                call.reject("TorrServer binary not found. Expected: " + nativeDir + "/" + LIB_NAME);
                return;
            }

            Log.i(TAG, "Starting TorrServer from: " + binary.getAbsolutePath());
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

    @PluginMethod
    public void getBinaryPath(PluginCall call) {
        File binary = getNativeBinary();
        JSObject r = new JSObject();
        r.put("path", binary != null ? binary.getAbsolutePath() : null);
        r.put("exists", binary != null && binary.exists());
        call.resolve(r);
    }

    // ── Native Binary Access ──

    /**
     * TorrServer упакован как libtorrserver.so в APK (jniLibs/arm64-v8a/).
     * Android автоматически извлекает его в nativeLibraryDir при установке.
     * Этот каталог исполняемый — можно запускать ProcessBuilder.
     */
    private File getNativeBinary() {
        try {
            String nativeDir = getContext().getApplicationInfo().nativeLibraryDir;
            File binary = new File(nativeDir, LIB_NAME);
            Log.i(TAG, "Native binary path: " + binary.getAbsolutePath() + " (exists=" + binary.exists() + ")");
            return binary;
        } catch (Exception e) {
            Log.e(TAG, "getNativeBinary failed", e);
            return null;
        }
    }

    // ── Process Management ──

    private void runBinary(File binary) {
        try {
            File dataDir = new File(getContext().getFilesDir(), "torrserver_data");
            dataDir.mkdirs();

            ProcessBuilder pb = new ProcessBuilder(
                binary.getAbsolutePath(),
                "--port", String.valueOf(PORT),
                "--ip", "0.0.0.0",
                "--path", dataDir.getAbsolutePath()
            );
            pb.directory(binary.getParentFile());
            pb.redirectErrorStream(true);
            process = pb.start();
            pid = getProcessPid(process);
            Log.i(TAG, "TorrServer started, pid=" + pid + ", port=" + PORT);

            // Читаем stdout в фоне (чтобы процесс не завис)
            new Thread(() -> {
                try {
                    java.io.InputStream is = process.getInputStream();
                    byte[] buf = new byte[1024];
                    int n;
                    while ((n = is.read(buf)) != -1) {
                        // Можно логировать вывод TorrServer
                    }
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

    // ── Foreground Notification ──

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "TorrServer", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("TorrServer streaming service");
            NotificationManager nm = getContext().getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(ch);
        }
    }

    private void startForeground() {
        try {
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

            NotificationManager nm = getContext().getSystemService(NotificationManager.class);
            if (nm != null) nm.notify(NOTIFICATION_ID, notification);
        } catch (Exception e) {
            Log.e(TAG, "startForeground failed", e);
        }
    }

    private void stopForeground() {
        try {
            NotificationManager nm = getContext().getSystemService(NotificationManager.class);
            if (nm != null) nm.cancel(NOTIFICATION_ID);
        } catch (Exception ignored) {}
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
