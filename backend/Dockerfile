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
WORKDIR /app
COPY --from=build /app/target/*.jar app.jar
ENV PORT=8080
EXPOSE 8080
# Cap the heap to a share of the container so the app doesn't OOM on a 512MB free tier.
ENTRYPOINT ["sh", "-c", "java -XX:MaxRAMPercentage=75.0 -jar app.jar --server.port=${PORT:-8080}"]
