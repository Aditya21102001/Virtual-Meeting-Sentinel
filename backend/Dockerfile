# Multi-stage build → small runtime image. Works on Koyeb / Render / Fly free tiers.
# Uses the Maven base image so no ./mvnw wrapper binary is required.
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /app
COPY pom.xml ./
COPY src ./src
# Note: no `dependency:go-offline` — it eagerly resolves a broken transitive
# (Yubico → jackson-dataformat-cbor → jackson-databind:2.19.5-SNAPSHOT, which doesn't exist).
# `package` uses the Spring-Boot-managed stable Jackson, so it resolves cleanly.
# Verbose (no -q) so the platform build log shows real compilation — a real build
# takes minutes; a sub-minute "build" means a cached layer shipped a stale jar.
RUN mvn clean package -DskipTests

FROM eclipse-temurin:21-jre

# FFmpeg + ffprobe: without them the video library still works, but only in progressive mode —
# uploads are served whole over HTTP Range instead of being split into an adaptive ladder, and
# the admin screen shows "FFmpeg not found". Both binaries ship in the single `ffmpeg` package.
#
# Installed from the distro rather than as a static binary so that the image carries Ubuntu's
# packaged build, whose corresponding source Ubuntu already publishes. Note that this build is
# GPL (it includes libx264): bundling it here means the IMAGE redistributes GPL software, which
# is fine and normal, but is a different position from merely invoking ffmpeg as a subprocess.
# The application's own MIT-licensed code is unaffected — separate processes, mere aggregation.
# See docs/THIRD_PARTY_LICENSES.md. Adds roughly 250 MB to the image; if that breaks a free-tier
# image-size limit, drop this layer and run with VIDEO_STORAGE_MODE/progressive delivery instead.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && ffmpeg -version \
    && ffprobe -version \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/target/*.jar app.jar
ENV PORT=8080
EXPOSE 8080
# Cap the heap to a share of the container so the app doesn't OOM on a 512MB free tier.
#
# 50%, not 75%, because FFmpeg is a SEPARATE PROCESS: its memory comes out of the container's
# limit but not out of the JVM heap. At 75% of a 512 MB instance the JVM alone reserves ~384 MB,
# and the first x264 encoder to start pushes the cgroup over its limit — the kernel then kills the
# whole container, which surfaces as a 502 from the platform's proxy (and, confusingly, as a CORS error in the
# browser, because an error page from the proxy carries no CORS headers).
# Override with JAVA_HEAP_PERCENT on an instance with real memory.
#
# NOTE: this is only the default. A JAVA_HEAP_PERCENT or JAVA_TOOL_OPTIONS set in the hosting
# platform's dashboard overrides it, and the JVM logs only that it *read* JAVA_TOOL_OPTIONS, never
# which value won. The application prints its effective ceiling at startup for exactly that reason —
# see AgmSentinelApplication.MemoryBudgetLogger.
ENV JAVA_HEAP_PERCENT=35.0
#
# The heap is not the whole JVM. Metaspace, the code cache and thread stacks live outside it and are
# unbounded by default, so "35% heap" can still mean a resident process far larger than 35% — and
# every megabyte of that is one FFmpeg cannot have. These caps make the JVM's total footprint
# predictable rather than merely its heap:
#
#   MaxMetaspaceSize   Spring Boot with Hibernate settles around 100-120 MB; 160 MB leaves headroom
#                      while turning unbounded growth into a clear error instead of a container kill.
#   ReservedCodeCacheSize  Defaults to 240 MB reserved. This app JITs a fraction of that.
#   MaxDirectMemorySize    WebClient/Netty allocate off-heap buffers outside every other limit.
ENV JAVA_MEMORY_LIMITS="-XX:MaxMetaspaceSize=160m -XX:ReservedCodeCacheSize=64m -XX:MaxDirectMemorySize=64m"
#
# -Djdk.lang.Process.launchMechanism=POSIX_SPAWN is not cosmetic in a small container.
# Spawning ffmpeg means the JVM creates a child process, and the default mechanism on Linux
# forks — briefly duplicating the parent's address space. The pages are copy-on-write, but the
# kernel still accounts for the reservation, so a JVM holding a few hundred MB can trip the
# cgroup limit at the exact moment it tries to start ffmpeg. The symptom is a container that
# dies at 0% of every transcode no matter how small the video is, because the failure is in
# launching the process, not in doing the work. posix_spawn does not duplicate the address space.
ENTRYPOINT ["sh", "-c", "java -XX:MaxRAMPercentage=${JAVA_HEAP_PERCENT} ${JAVA_MEMORY_LIMITS} -XX:ActiveProcessorCount=1 -XX:+ExitOnOutOfMemoryError -Djdk.lang.Process.launchMechanism=POSIX_SPAWN -jar app.jar --server.port=${PORT:-8080}"]
