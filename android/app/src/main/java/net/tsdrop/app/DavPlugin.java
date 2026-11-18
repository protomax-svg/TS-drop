package net.tsdrop.app;

import android.Manifest;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.res.AssetFileDescriptor;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.webkit.MimeTypeMap;
import android.database.Cursor;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;

import androidx.annotation.RequiresApi;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PermissionState;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStreamWriter;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.Map;
import java.io.OutputStream;
import java.security.SecureRandom;
import java.util.Iterator;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okio.BufferedSink;

import org.json.JSONObject;

/**
 * All HTTP for the app.
 *  - java.net.HttpURLConnection (what CapacitorHttp uses) refuses PROPFIND and MKCOL, OkHttp does not.
 *  - upload/download stream straight from and to disk, so file size does not matter.
 *  - with a key, bytes are AES-256-GCM: [12B IV][ciphertext||16B tag], the same layout
 *    WebCrypto and electron/main.cjs produce.
 */
@CapacitorPlugin(
    name = "Dav",
    permissions = {
        @Permission(strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }, alias = "storage"),
        @Permission(strings = { Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO }, alias = "media"),
        @Permission(strings = { Manifest.permission.READ_EXTERNAL_STORAGE }, alias = "mediaLegacy")
    }
)
public class DavPlugin extends Plugin {

    private static final int BUF = 1 << 16;
    private static final int PREVIEW_MAX = 24 << 20;
    private static final int READ_MAX = 64 << 20;
    private static final int OG_MAX = 128 << 10;
    private static final String OG_UA = "Mozilla/5.0 (compatible; TSDROP link preview)";

    private final OkHttpClient client = new OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(0, TimeUnit.MILLISECONDS)
        .retryOnConnectionFailure(true)
        .build();

    /* Link cards fetch pages nobody here controls, so this path is deliberately strict:
       http(s) only, a hard byte cap, real timeouts, and no app credentials ever attached.
       The main client has no read timeout because file transfers need that; this one does. */
    /* The shared client waits forever on purpose: a 4GB upload must not be cut off. A preview
       must not, or a stalled socket holds a slot in the app's queue and nothing else loads. */
    private final OkHttpClient previewClient = client.newBuilder()
        .readTimeout(25, TimeUnit.SECONDS)
        .callTimeout(40, TimeUnit.SECONDS)
        .build();

    private final OkHttpClient ogClient = client.newBuilder()
        .readTimeout(8, TimeUnit.SECONDS)
        .callTimeout(12, TimeUnit.SECONDS)
        .build();

    /* ---------------- helpers ---------------- */

    private static String msg(Throwable e) {
        return e.getMessage() == null ? e.toString() : e.getMessage();
    }

    private static byte[] keyOf(PluginCall call) {
        String k = call.getString("key", null);
        return k == null || k.isEmpty() ? null : Base64.decode(k, Base64.NO_WRAP);
    }

    private static Cipher gcm(int mode, byte[] key, byte[] iv) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(mode, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
        return c;
    }

    private static void applyHeaders(Request.Builder b, JSObject h) {
        Iterator<String> keys = h.keys();
        while (keys.hasNext()) {
            String k = keys.next();
            String v = h.getString(k, null);
            if (v != null) b.header(k, v);
        }
    }

    private void progress(String url, long loaded, long total) {
        JSObject o = new JSObject();
        o.put("url", url);
        o.put("loaded", loaded);
        o.put("total", total);
        notifyListeners("progress", o);
    }

    private long sizeOf(Uri uri) {
        try (AssetFileDescriptor afd = getContext().getContentResolver().openAssetFileDescriptor(uri, "r")) {
            if (afd != null && afd.getLength() >= 0) return afd.getLength();
        } catch (Exception ignored) {}
        try (Cursor c = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int i = c.getColumnIndex(OpenableColumns.SIZE);
                if (i >= 0 && !c.isNull(i)) return c.getLong(i);
            }
        } catch (Exception ignored) {}
        return -1;
    }

    private static void readFully(InputStream in, byte[] b) throws IOException {
        int off = 0;
        while (off < b.length) {
            int n = in.read(b, off, b.length - off);
            if (n < 0) throw new IOException("stream ended early");
            off += n;
        }
    }

    private static File unique(File dir, String name) {
        File f = new File(dir, name);
        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; f.exists() && i < 1000; i++) f = new File(dir, stem + " (" + i + ")" + ext);
        return f;
    }

    /** a mime for the name, never null: MediaStore refuses an entry without one */
    private static String mimeOf(String name) {
        int dot = name.lastIndexOf('.');
        String m = dot < 0 ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(
            name.substring(dot + 1).toLowerCase(Locale.ROOT));
        return m == null ? "application/octet-stream" : m;
    }

    /**
     * Every saved file has to live in MediaStore or the user never sees it: getExternalFilesDir
     * is app-private and Android 11+ hides Android/data from every file manager. Media lands in
     * the gallery, everything else in Download/TSDROP.
     * ponytail: API 29+ only. On 24-28 this needs WRITE_EXTERNAL_STORAGE plus a runtime
     * permission dance, so those keep the old app-folder path.
     */
    @RequiresApi(29)
    private Uri newStoreEntry(String name, String mime) {
        String sub = mime.startsWith("image/") ? Environment.DIRECTORY_PICTURES
            : mime.startsWith("video/") ? Environment.DIRECTORY_MOVIES
            : mime.startsWith("audio/") ? Environment.DIRECTORY_MUSIC : Environment.DIRECTORY_DOWNLOADS;
        Uri table = mime.startsWith("image/") ? MediaStore.Images.Media.EXTERNAL_CONTENT_URI
            : mime.startsWith("video/") ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI
            : mime.startsWith("audio/") ? MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
            : MediaStore.Downloads.EXTERNAL_CONTENT_URI;
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, sub + "/TSDROP");
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);   // hidden from the gallery until we finish
        return getContext().getContentResolver().insert(table, v);
    }

    @RequiresApi(29)
    private void publish(Uri uri) {
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.IS_PENDING, 0);
        getContext().getContentResolver().update(uri, v, null, null);
    }

    /**
     * Android 9 and older: the public Pictures/Movies/Music/Download folders need a write
     * permission, and the media scanner has to be told about the new file by hand.
     * Returns null when we may not write there, and the caller falls back to the app folder.
     */
    private File legacyPublicFile(String mime, String name) {
        if (Build.VERSION.SDK_INT >= 29 || getPermissionState("storage") != PermissionState.GRANTED) return null;
        String sub = mime.startsWith("image/") ? Environment.DIRECTORY_PICTURES
            : mime.startsWith("video/") ? Environment.DIRECTORY_MOVIES
            : mime.startsWith("audio/") ? Environment.DIRECTORY_MUSIC : Environment.DIRECTORY_DOWNLOADS;
        File dir = new File(Environment.getExternalStoragePublicDirectory(sub), "TSDROP");
        if (!dir.exists() && !dir.mkdirs()) return null;
        return unique(dir, name);
    }

    /** Asked once at app start, and only on Android 9 and older. Newer ones need nothing. */
    @PluginMethod
    public void requestStorage(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 29 || getPermissionState("storage") == PermissionState.GRANTED) { call.resolve(); return; }
        requestPermissionForAlias("storage", call, "storageResult");
    }

    @PermissionCallback
    private void storageResult(PluginCall call) { call.resolve(); }

    /* READ_MEDIA_* exist only on API 33+; older devices reach the same rows through READ_EXTERNAL_STORAGE */
    private static String mediaAlias() { return Build.VERSION.SDK_INT >= 33 ? "media" : "mediaLegacy"; }

    /** Asked the first time the camera roll is listed. */
    @PluginMethod
    public void requestMedia(PluginCall call) {
        if (getPermissionState(mediaAlias()) == PermissionState.GRANTED) { call.resolve(); return; }
        requestPermissionForAlias(mediaAlias(), call, "mediaResult");
    }

    @PermissionCallback
    private void mediaResult(PluginCall call) { call.resolve(); }

    /**
     * The camera roll, newest first: { files: [{ name, size, mtime, path }] }.
     * path is the content:// URI, so upload() streams it straight to the server with no temp copy.
     * ponytail: API 34 partial access (READ_MEDIA_VISUAL_USER_SELECTED) reads as not granted here,
     * so this asks for full access; add that alias if per-item picking is ever wanted.
     */
    @PluginMethod
    public void gallery(PluginCall call) {
        if (getPermissionState(mediaAlias()) != PermissionState.GRANTED) {
            call.reject("media permission not granted - call requestMedia first");
            return;
        }
        final long since = call.getLong("since", 0L);
        final int limit = Math.max(1, call.getInt("limit", 500));
        new Thread(() -> {
            final Uri table = MediaStore.Files.getContentUri("external");
            String[] cols = {
                MediaStore.Files.FileColumns._ID,
                MediaStore.Files.FileColumns.DISPLAY_NAME,
                MediaStore.Files.FileColumns.SIZE,
                MediaStore.Files.FileColumns.DATE_MODIFIED };
            String where = MediaStore.Files.FileColumns.MEDIA_TYPE + " IN (?,?) AND "
                + MediaStore.Files.FileColumns.DATE_MODIFIED + " > ?";
            String[] args = {
                String.valueOf(MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE),
                String.valueOf(MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO),
                String.valueOf(since / 1000) };   // DATE_MODIFIED is seconds
            try (Cursor c = getContext().getContentResolver().query(
                    table, cols, where, args, MediaStore.Files.FileColumns.DATE_MODIFIED + " DESC")) {
                if (c == null) { call.reject("cannot read the gallery"); return; }
                int iId = c.getColumnIndexOrThrow(MediaStore.Files.FileColumns._ID);
                int iName = c.getColumnIndexOrThrow(MediaStore.Files.FileColumns.DISPLAY_NAME);
                int iSize = c.getColumnIndexOrThrow(MediaStore.Files.FileColumns.SIZE);
                int iMod = c.getColumnIndexOrThrow(MediaStore.Files.FileColumns.DATE_MODIFIED);
                JSArray files = new JSArray();
                while (files.length() < limit && c.moveToNext()) {
                    String name = c.isNull(iName) ? null : c.getString(iName);
                    long size = c.isNull(iSize) ? 0 : c.getLong(iSize);
                    if (name == null || name.trim().isEmpty() || size <= 0) continue;
                    JSObject o = new JSObject();
                    o.put("name", name);
                    o.put("size", size);
                    o.put("mtime", (c.isNull(iMod) ? 0 : c.getLong(iMod)) * 1000);
                    o.put("path", ContentUris.withAppendedId(table, c.getLong(iId)).toString());
                    files.put(o);
                }
                JSObject out = new JSObject();
                out.put("files", files);
                call.resolve(out);
            } catch (Exception e) { call.reject(msg(e)); }
        }).start();
    }

    /** Hand a saved file to whatever app opens it — the gallery, for media. */
    @PluginMethod
    public void open(PluginCall call) {
        String p = call.getString("path");
        if (p == null) { call.reject("path is required"); return; }
        try {
            Uri uri = p.startsWith("content://") ? Uri.parse(p)
                : androidx.core.content.FileProvider.getUriForFile(
                    getContext(), getContext().getPackageName() + ".fileprovider", new File(p));
            String mime = getContext().getContentResolver().getType(uri);
            Intent i = new Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, mime == null ? "*/*" : mime)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) { call.reject(msg(e)); }
    }

    /* ---------------- direct mode: serve our own files over the tailnet ----------------
       Runs while the app process is alive. Android will eventually kill it in the
       background, which is fine: you open the app when you want to hand a file over. */

    private ServerSocket blobSocket;
    private int blobPort = 0;
    private final Map<String, String> blobUri = new HashMap<>();

    /* tokens have to outlive the process: a file offered yesterday must still be fetchable today */
    private File blobStore() { return new File(getContext().getFilesDir(), "blobs.json"); }

    private synchronized void loadBlobs() {
        try {
            File f = blobStore();
            if (!f.exists()) return;
            byte[] raw = new byte[(int) f.length()];
            try (InputStream in = new java.io.FileInputStream(f)) { readFully(in, raw); }
            JSONObject o = new JSONObject(new String(raw, StandardCharsets.UTF_8));
            for (Iterator<String> it = o.keys(); it.hasNext();) { String k = it.next(); blobUri.put(k, o.getString(k)); }
        } catch (Exception ignored) {}
    }

    private synchronized void saveBlobs() {
        try (OutputStream out = new FileOutputStream(blobStore())) {
            out.write(new JSONObject(blobUri).toString().getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) {}
    }

    @Override
    public void load() {
        loadBlobs();
        String ip = tailnetIp();
        if (ip != null) startBlobServer(ip);
    }

    /** our 100.64.0.0/10 address, whatever the tailscale interface is called */
    private static String tailnetIp() {
        try {
            for (Enumeration<NetworkInterface> e = NetworkInterface.getNetworkInterfaces(); e.hasMoreElements();) {
                for (Enumeration<InetAddress> a = e.nextElement().getInetAddresses(); a.hasMoreElements();) {
                    InetAddress ad = a.nextElement();
                    if (!(ad instanceof Inet4Address) || ad.isLoopbackAddress()) continue;
                    String[] p = ad.getHostAddress().split("\\.");
                    int o0 = Integer.parseInt(p[0]), o1 = Integer.parseInt(p[1]);
                    if (o0 == 100 && o1 >= 64 && o1 <= 127) return ad.getHostAddress();
                }
            }
        } catch (Exception ignored) {}
        return null;
    }

    private synchronized int startBlobServer(String ip) {
        if (blobSocket != null && !blobSocket.isClosed()) return blobPort;
        try {
            try {
                blobSocket = new ServerSocket();
                blobSocket.setReuseAddress(true);
                blobSocket.bind(new InetSocketAddress(ip, 8421));
            } catch (IOException busy) {
                blobSocket = new ServerSocket();
                blobSocket.setReuseAddress(true);
                blobSocket.bind(new InetSocketAddress(ip, 0));
            }
            blobPort = blobSocket.getLocalPort();
            final ServerSocket ss = blobSocket;
            Thread t = new Thread(() -> {
                while (!ss.isClosed()) {
                    try {
                        final Socket c = ss.accept();
                        new Thread(() -> serveOne(c)).start();
                    } catch (IOException e) { break; }
                }
            });
            t.setDaemon(true);
            t.start();
            return blobPort;
        } catch (Exception e) { blobSocket = null; blobPort = 0; return 0; }
    }

    private void serveOne(Socket c) {
        try (Socket sock = c) {
            sock.setSoTimeout(20000);
            InputStream in = sock.getInputStream();
            StringBuilder line = new StringBuilder();
            int ch;
            while ((ch = in.read()) != -1 && ch != '\n' && line.length() < 2048) if (ch != '\r') line.append((char) ch);
            String[] parts = line.toString().split(" ");
            String target = parts.length > 1 ? parts[1] : "";
            OutputStream out = sock.getOutputStream();

            if (target.equals("/ping")) { header(out, 200, 6); out.write("tsdrop".getBytes(StandardCharsets.UTF_8)); out.flush(); return; }
            String token = target.startsWith("/b/") ? target.substring(3) : null;
            String uriStr = token == null ? null : blobUri.get(token);
            if (uriStr == null) { header(out, 404, 0); out.flush(); return; }

            Uri uri = Uri.parse(uriStr);
            long size = sizeOf(uri);
            if (size < 0) { header(out, 410, 0); out.flush(); return; }
            header(out, 200, size);
            try (InputStream src = getContext().getContentResolver().openInputStream(uri)) {
                if (src == null) return;
                byte[] buf = new byte[BUF];
                int n;
                while ((n = src.read(buf)) != -1) out.write(buf, 0, n);
            }
            out.flush();
        } catch (Exception ignored) {}
    }

    private static void header(OutputStream out, int code, long len) throws IOException {
        String h = "HTTP/1.1 " + code + " \r\nContent-Length: " + len
            + "\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n";
        out.write(h.getBytes(StandardCharsets.UTF_8));
    }

    /** Register a local file for direct pickup and say where to get it. */
    /** OS share sheet. paths are exactly what download() handed back: content:// or absolute. */
    @PluginMethod
    public void share(PluginCall call) {
        String text = call.getString("text", "");
        JSArray arr = call.getArray("paths", new JSArray());
        try {
            java.util.ArrayList<Uri> uris = new java.util.ArrayList<>();
            String mime = null;
            for (Object o : arr.toList()) {
                String p = String.valueOf(o);
                if (p.startsWith("content://")) uris.add(Uri.parse(p));
                else uris.add(androidx.core.content.FileProvider.getUriForFile(
                        getContext(), getContext().getPackageName() + ".fileprovider",
                        new File(p.startsWith("file://") ? Uri.parse(p).getPath() : p)));
                Uri u = uris.get(uris.size() - 1);
                // a content:// uri carries no extension, so the resolver is the only source of a type
                String m = "content".equals(u.getScheme()) ? getContext().getContentResolver().getType(u) : mimeOf(p);
                if (m == null) m = "*/*";
                mime = mime == null || mime.equals(m) ? m : "*/*";
            }
            Intent i;
            if (uris.isEmpty()) {
                i = new Intent(Intent.ACTION_SEND).setType("text/plain");
            } else if (uris.size() == 1) {
                i = new Intent(Intent.ACTION_SEND).setType(mime == null ? "*/*" : mime);
                i.putExtra(Intent.EXTRA_STREAM, uris.get(0));
                i.setClipData(ClipData.newRawUri("", uris.get(0)));
            } else {
                i = new Intent(Intent.ACTION_SEND_MULTIPLE).setType(mime == null ? "*/*" : mime);
                i.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
            }
            if (!text.isEmpty()) i.putExtra(Intent.EXTRA_TEXT, text);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(i, "share")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getContext().startActivity(chooser);
            call.resolve();
        } catch (Exception e) { call.reject(msg(e)); }
    }

    @PluginMethod
    public void serve(PluginCall call) {
        String path = call.getString("path");
        if (path == null) { call.reject("path is required"); return; }
        String ip = tailnetIp();
        JSObject o = new JSObject();
        if (ip == null) { call.resolve(o); return; }
        int port = startBlobServer(ip);
        if (port == 0) { call.resolve(o); return; }
        String token = Long.toHexString(System.nanoTime()) + Integer.toHexString((int) (Math.random() * 0xFFFFFF));
        blobUri.put(token, path);
        saveBlobs();
        o.put("ip", ip);
        o.put("port", port);
        o.put("token", token);
        call.resolve(o);
    }

    @PluginMethod
    public void unserve(PluginCall call) {
        String t = call.getString("token");
        if (t != null) { blobUri.remove(t); saveBlobs(); }
        call.resolve();
    }

    /* ---------------- small requests ---------------- */

    @PluginMethod
    public void request(PluginCall call) {
        final String method = call.getString("method", "GET").toUpperCase(Locale.ROOT);
        final String url = call.getString("url");
        final String body = call.getString("body", null);
        final String bodyB64 = call.getString("bodyB64", null);
        final JSObject headers = call.getObject("headers", new JSObject());
        if (url == null || url.isEmpty()) { call.reject("url is required"); return; }

        String ct = headers.getString("Content-Type", null);
        MediaType mt = MediaType.parse(ct != null ? ct : "application/octet-stream");

        RequestBody rb = null;
        if (bodyB64 != null) rb = RequestBody.create(Base64.decode(bodyB64, Base64.NO_WRAP), mt);
        else if (body != null) rb = RequestBody.create(body, mt);
        else if (method.equals("PUT") || method.equals("POST") || method.equals("PATCH")) rb = RequestBody.create(new byte[0], null);

        final Request.Builder b;
        try { b = new Request.Builder().url(url).method(method, rb); }
        catch (IllegalArgumentException e) { call.reject("bad request: " + e.getMessage()); return; }
        applyHeaders(b, headers);

        final Request req = b.build();
        // Probes (finding a server that answers) pass a timeout; transfers never do.
        final int timeout = call.getInt("timeout", 0);
        final OkHttpClient c = timeout > 0
            ? client.newBuilder()
                .connectTimeout(timeout, TimeUnit.MILLISECONDS)
                .callTimeout(timeout, TimeUnit.MILLISECONDS)
                .build()
            : client;
        new Thread(() -> {
            try (Response r = c.newCall(req).execute()) {
                JSObject out = new JSObject();
                out.put("status", r.code());
                out.put("data", r.body() == null ? "" : r.body().string());
                call.resolve(out);
            } catch (Exception e) { call.reject(msg(e)); }
        }).start();
    }

    /** Bytes of a local file or content:// item. Previews are made from these before upload. */
    @PluginMethod
    public void read(PluginCall call) {
        final String path = call.getString("path");
        if (path == null) { call.reject("path is required"); return; }
        new Thread(() -> {
            try (InputStream in = getContext().getContentResolver().openInputStream(Uri.parse(path))) {
                if (in == null) { call.reject("cannot read " + path); return; }
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[BUF];
                int n;
                long total = 0;
                while ((n = in.read(buf)) != -1) {
                    total += n;
                    if (total > READ_MAX) { call.reject("too big to read"); return; }
                    bos.write(buf, 0, n);
                }
                JSObject o = new JSObject();
                o.put("data", Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP));
                call.resolve(o);
            } catch (Exception e) { call.reject(msg(e)); }
        }).start();
    }

    /** A page's head, for a link card. OkHttp follows the redirects; we stop at OG_MAX bytes. */
    @PluginMethod
    public void og(PluginCall call) {
        final String url = call.getString("url");
        if (url == null || !url.matches("(?i)^https?://.+")) { call.reject("http(s) url required"); return; }
        final Request req = new Request.Builder().url(url)
            .header("Accept", "text/html,*/*").header("User-Agent", OG_UA).get().build();
        new Thread(() -> {
            JSObject o = new JSObject();
            o.put("data", "");
            try (Response r = ogClient.newCall(req).execute()) {
                String ct = r.header("Content-Type");
                if (!r.isSuccessful() || r.body() == null
                    || ct == null || !ct.toLowerCase(Locale.ROOT).contains("html")) { call.resolve(o); return; }
                InputStream in = r.body().byteStream();
                java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[BUF];
                int n;
                while (bos.size() < OG_MAX && (n = in.read(buf)) != -1) bos.write(buf, 0, Math.min(n, OG_MAX - bos.size()));
                o.put("data", new String(bos.toByteArray(), StandardCharsets.UTF_8));
            } catch (Exception ignored) {}
            call.resolve(o);
        }).start();
    }

    /** Whole body as base64. Used for image previews only, so it is size capped. */
    @PluginMethod
    public void getBytes(PluginCall call) {
        final String url = call.getString("url");
        final JSObject headers = call.getObject("headers", new JSObject());
        if (url == null || url.isEmpty()) { call.reject("url is required"); return; }
        final Request.Builder b = new Request.Builder().url(url).get();
        applyHeaders(b, headers);
        final Request req = b.build();
        new Thread(() -> {
            try (Response r = previewClient.newCall(req).execute()) {
                if (r.code() >= 400) { call.reject("HTTP " + r.code()); return; }
                if (r.body() == null) { call.reject("empty body"); return; }
                if (r.body().contentLength() > PREVIEW_MAX) { call.reject("too big to preview"); return; }
                byte[] raw = r.body().bytes();
                JSObject out = new JSObject();
                out.put("status", r.code());
                out.put("data", Base64.encodeToString(raw, Base64.NO_WRAP));
                call.resolve(out);
            } catch (Exception e) { call.reject(msg(e)); }
        }).start();
    }

    /**
     * Android does not hand clipboard images to a WebView textarea, so read the clipboard
     * ourselves and copy the image into the cache dir where the uploader can stream it.
     */
    @PluginMethod
    public void clipboardImage(PluginCall call) {
        try {
            ClipboardManager cm = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = cm == null ? null : cm.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) { call.resolve(new JSObject()); return; }
            Uri uri = clip.getItemAt(0).getUri();
            if (uri == null) { call.resolve(new JSObject()); return; }
            String mime = getContext().getContentResolver().getType(uri);
            if (mime == null || !mime.startsWith("image/")) { call.resolve(new JSObject()); return; }

            String ext = mime.substring(6).replaceAll("[^a-zA-Z0-9]", "");
            if (ext.isEmpty()) ext = "png";
            File dir = new File(getContext().getCacheDir(), "paste");
            if (!dir.exists() && !dir.mkdirs()) { call.reject("cannot create " + dir); return; }
            File f = new File(dir, "pasted-" + System.currentTimeMillis() + "." + ext);

            long n = 0;
            try (InputStream in = getContext().getContentResolver().openInputStream(uri);
                 OutputStream os = new FileOutputStream(f)) {
                if (in == null) { call.reject("cannot read the clipboard image"); return; }
                byte[] buf = new byte[BUF];
                int r;
                while ((r = in.read(buf)) != -1) { os.write(buf, 0, r); n += r; }
            }
            JSObject o = new JSObject();
            o.put("name", f.getName());
            o.put("size", n);
            o.put("path", Uri.fromFile(f).toString());
            call.resolve(o);
        } catch (Exception e) { call.reject(msg(e)); }
    }

    /** Clipboard images arrive as bytes; the uploader streams from a path, so park them on disk. */
    @PluginMethod
    public void writeTemp(PluginCall call) {
        String name = call.getString("name", "pasted.png").replaceAll("[^A-Za-z0-9._-]", "_");
        String data = call.getString("data");
        if (data == null) { call.reject("data is required"); return; }
        try {
            File dir = new File(getContext().getCacheDir(), "paste");
            if (!dir.exists() && !dir.mkdirs()) { call.reject("cannot create " + dir); return; }
            File f = new File(dir, System.currentTimeMillis() + "-" + name);
            byte[] raw = Base64.decode(data, Base64.NO_WRAP);
            try (OutputStream os = new FileOutputStream(f)) { os.write(raw); }
            JSObject o = new JSObject();
            o.put("path", Uri.fromFile(f).toString());
            o.put("size", raw.length);
            call.resolve(o);
        } catch (Exception e) { call.reject(msg(e)); }
    }

    /* ---------------- streamed transfers ---------------- */

    @PluginMethod
    public void upload(PluginCall call) {
        final String url = call.getString("url");
        final String path = call.getString("path");
        final JSObject headers = call.getObject("headers", new JSObject());
        final byte[] key = keyOf(call);
        if (url == null || path == null) { call.reject("url and path are required"); return; }

        new Thread(() -> {
            try {
                final Uri uri = Uri.parse(path);
                final long plain = sizeOf(uri);
                final long wire = plain < 0 ? -1 : plain + (key == null ? 0 : 28);

                RequestBody body = new RequestBody() {
                    @Override public MediaType contentType() { return MediaType.parse("application/octet-stream"); }
                    @Override public long contentLength() { return wire; }
                    @Override public void writeTo(BufferedSink sink) throws IOException {
                        InputStream in = getContext().getContentResolver().openInputStream(uri);
                        if (in == null) throw new IOException("cannot read " + uri);
                        try {
                            Cipher c = null;
                            if (key != null) {
                                byte[] iv = new byte[12];
                                new SecureRandom().nextBytes(iv);
                                sink.write(iv);
                                try { c = gcm(Cipher.ENCRYPT_MODE, key, iv); }
                                catch (Exception e) { throw new IOException(msg(e)); }
                            }
                            byte[] buf = new byte[BUF];
                            long sent = 0, last = 0;
                            int n;
                            while ((n = in.read(buf)) != -1) {
                                if (c == null) sink.write(buf, 0, n);
                                else { byte[] p = c.update(buf, 0, n); if (p != null && p.length > 0) sink.write(p); }
                                sent += n;
                                long now = System.currentTimeMillis();
                                if (now - last > 150) { last = now; progress(url, sent, plain); }
                            }
                            if (c != null) {
                                try { byte[] f = c.doFinal(); if (f != null && f.length > 0) sink.write(f); }
                                catch (Exception e) { throw new IOException(msg(e)); }
                            }
                            progress(url, sent, plain);
                        } finally { try { in.close(); } catch (IOException ignored) {} }
                    }
                };

                Request.Builder b = new Request.Builder().url(url).put(body);
                applyHeaders(b, headers);
                b.header("Content-Type", "application/octet-stream");
                try (Response r = client.newCall(b.build()).execute()) {
                    JSObject out = new JSObject();
                    out.put("status", r.code());
                    out.put("data", r.body() == null ? "" : r.body().string());
                    call.resolve(out);
                }
            } catch (Exception e) { call.reject(msg(e)); }
        }).start();
    }

    @PluginMethod
    public void download(PluginCall call) {
        final String url = call.getString("url");
        final String name = call.getString("name", "file");
        final JSObject headers = call.getObject("headers", new JSObject());
        final byte[] key = keyOf(call);
        if (url == null) { call.reject("url is required"); return; }

        final Request.Builder b = new Request.Builder().url(url).get();
        applyHeaders(b, headers);
        final Request req = b.build();

        new Thread(() -> {
            File out = null;
            Uri gallery = null;
            String scan = null;
            try (Response r = client.newCall(req).execute()) {
                if (r.code() >= 400) { call.reject("HTTP " + r.code()); return; }
                if (r.body() == null) { call.reject("empty body"); return; }

                String mime = mimeOf(name);
                if (Build.VERSION.SDK_INT >= 29) gallery = newStoreEntry(name, mime);
                if (gallery == null) { out = legacyPublicFile(mime, name); if (out != null) scan = mime; }
                if (gallery == null && out == null) {
                    File dir = new File(getContext().getExternalFilesDir(null), "tsdrop");
                    if (!dir.exists() && !dir.mkdirs()) { call.reject("cannot create " + dir); return; }
                    out = unique(dir, name);
                }

                long wire = r.body().contentLength();
                final long total = wire > 0 ? Math.max(0, wire - (key == null ? 0 : 28)) : 0;

                InputStream in = r.body().byteStream();
                Cipher c = null;
                if (key != null) {
                    byte[] iv = new byte[12];
                    readFully(in, iv);
                    c = gcm(Cipher.DECRYPT_MODE, key, iv);
                }
                OutputStream sink = gallery != null
                    ? getContext().getContentResolver().openOutputStream(gallery)
                    : new FileOutputStream(out);
                if (sink == null) { call.reject("cannot open the output file"); return; }
                try (OutputStream os = sink) {
                    byte[] buf = new byte[BUF];
                    long got = 0, last = 0;
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        if (c == null) { os.write(buf, 0, n); got += n; }
                        else { byte[] p = c.update(buf, 0, n); if (p != null && p.length > 0) { os.write(p); got += p.length; } }
                        long now = System.currentTimeMillis();
                        if (now - last > 150) { last = now; progress(url, got, total); }
                    }
                    if (c != null) {
                        // throws if the tag does not verify - wrong password or damaged data
                        byte[] f = c.doFinal();
                        if (f != null && f.length > 0) { os.write(f); got += f.length; }
                    }
                    progress(url, got, total);
                }
                if (gallery != null) publish(gallery);
                if (scan != null) MediaScannerConnection.scanFile(getContext(), new String[]{ out.getAbsolutePath() }, new String[]{ scan }, null);
                JSObject o = new JSObject();
                o.put("status", r.code());
                o.put("path", gallery != null ? gallery.toString() : out.getAbsolutePath());
                o.put("name", name);
                call.resolve(o);
            } catch (Exception e) {
                if (out != null) { try { out.delete(); } catch (Exception ignored) {} }
                if (gallery != null) { try { getContext().getContentResolver().delete(gallery, null, null); } catch (Exception ignored) {} }
                call.reject(msg(e));
            }
        }).start();
    }
}
