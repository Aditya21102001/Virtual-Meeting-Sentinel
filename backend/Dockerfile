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
# See THIRD_PARTY_LICENSES.md. Adds roughly 250 MB to the image; if that breaks a free-tier
# image-size limit, drop this layer and run with VIDEO_STORAGE_MODE/progressive delivery instead.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
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
# whole container, which surfaces as a 502 from the platform's proxy (and, confusingly, as a CORS
# error in the browser, because an error page from the proxy carries no CORS headers).
# Override with JAVA_HEAP_PERCENT on an instance with real memory.
ENV JAVA_HEAP_PERCENT=50.0
ENTRYPOINT ["sh", "-c", "java -XX:MaxRAMPercentage=${JAVA_HEAP_PERCENT} -XX:+ExitOnOutOfMemoryError -jar app.jar --server.port=${PORT:-8080}"]
