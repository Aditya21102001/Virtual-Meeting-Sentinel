# Multi-stage build → small runtime image. Works on Koyeb / Render / Fly free tiers.
# Uses the Maven base image so no ./mvnw wrapper binary is required.
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /app
COPY pom.xml ./
COPY src ./src
# Note: no `dependency:go-offline` — it eagerly resolves a broken transitive
# (Yubico → jackson-dataformat-cbor → jackson-databind:2.19.5-SNAPSHOT, which doesn't exist).
# `package` uses the Spring-Boot-managed stable Jackson, so it resolves cleanly.
RUN mvn -q clean package -DskipTests

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /app/target/*.jar app.jar
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["sh", "-c", "java -jar app.jar --server.port=${PORT:-8080}"]
