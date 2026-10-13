# PlatformIO pre-build script: copies patched ESP_SSLClient headers over the
# downloaded library (see patches/README.md for what they change and why).
Import("env")
import os, shutil
proj = env.subst("$PROJECT_DIR")
libdeps = env.subst("$PROJECT_LIBDEPS_DIR")
envname = env.subst("$PIOENV")
dst = os.path.join(libdeps, envname, "ESP_SSLClient", "src", "client")
if os.path.isdir(dst):
    for f in ("SSLClient.h", "TCPClient.h"):
        shutil.copyfile(os.path.join(proj, "patches", f), os.path.join(dst, f))
    print("apply_patches: ESP_SSLClient patched")
else:
    print("apply_patches: ESP_SSLClient not installed yet; run the build again")
