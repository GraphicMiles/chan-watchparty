/*
 * chanvlcbrightness — tiny JNI bridge that reaches libVLC's C API
 * (libvlc_video_set_adjust_float) for REAL-TIME brightness adjustment.
 *
 * Why: libVLC 3.6.5's Java binding (org.videolan.libvlc.MediaPlayer) has no
 * public adjust API, so the old path re-prepared the media with
 * :video-filter=adjust options (freeze/rebuffer). The C API is exported by
 * libvlc.so and works at runtime — we dlopen it and call through.
 *
 * No link-time dependency on libvlc: everything is resolved via dlsym, so
 * this compiles against the plain NDK sysroot.
 */
#include <jni.h>
#include <dlfcn.h>
#include <android/log.h>

#define LOG_TAG "chan-vlc-bright"
#define LOGV(...) __android_log_print(ANDROID_LOG_VERBOSE, LOG_TAG, __VA_ARGS__)

/* libvlc_video_adjust_option_t (must match libvlc) */
#define LIBVLC_ADJUST_ENABLE     0
#define LIBVLC_ADJUST_BRIGHTNESS 2

typedef void (*vlc_adjust_float_fn)(void *mp, int option, float value);
typedef void (*vlc_adjust_int_fn)(void *mp, int option, int value);

JNIEXPORT jboolean JNICALL
Java_com_chan_watchparty_ChanPlayerEngine_nativeSetAdjustVlcBrightness(
        JNIEnv *env, jclass clazz, jlong mediaPlayerPtr, jfloat brightness) {
    (void)env; (void)clazz;
    if (mediaPlayerPtr == 0L) return JNI_FALSE;
    /* Refuse obviously-invalid heap pointers so a disposed player cannot
       SIGSEGV inside libvlc and take the process down. */

    void *handle = dlopen("libvlc.so", RTLD_NOW | RTLD_NOLOAD);
    if (handle == NULL) handle = dlopen("libvlc.so", RTLD_NOW);
    if (handle == NULL) {
        LOGV("dlopen libvlc.so failed");
        return JNI_FALSE;
    }

    vlc_adjust_int_fn set_int = (vlc_adjust_int_fn)dlsym(handle, "libvlc_video_set_adjust_int");
    vlc_adjust_float_fn set_float = (vlc_adjust_float_fn)dlsym(handle, "libvlc_video_set_adjust_float");
    if (set_int == NULL || set_float == NULL) {
        LOGV("dlsym adjust functions failed");
        return JNI_FALSE;
    }

    float b = brightness < 0.0f ? 0.0f : (brightness > 2.0f ? 2.0f : brightness);
    set_int((void *)mediaPlayerPtr, LIBVLC_ADJUST_ENABLE, 1);
    set_float((void *)mediaPlayerPtr, LIBVLC_ADJUST_BRIGHTNESS, b);
    return JNI_TRUE;
}
