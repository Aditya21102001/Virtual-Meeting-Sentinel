package com.agmsentinel.config;

import io.netty.channel.ChannelOption;
import io.netty.handler.timeout.ReadTimeoutHandler;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.client.reactive.ReactorClientHttpConnector;
import reactor.netty.http.client.HttpClient;
import reactor.netty.resources.ConnectionProvider;

import java.time.Duration;

/**
 * The HTTP connector used to reach the AI service.
 *
 * <h2>Why this exists at all</h2>
 * The client was previously built with a base URL and nothing else, which means it inherited
 * reactor-netty's JVM-global defaults. Three of those defaults are wrong for this deployment, and
 * each produces an intermittent failure that looks like something else:
 *
 * <ul>
 *   <li><b>No idle eviction.</b> A keep-alive connection that the platform's edge has already
 *       closed stays in the pool and gets handed to the next caller, which fails with a premature
 *       close. It affects one request out of many and moves around, so it reads as flakiness rather
 *       than as configuration.
 *   <li><b>No connect timeout.</b> A request to a host that is not accepting connections waits on
 *       the OS default — far longer than any user will.
 *   <li><b>No response timeout.</b> The only bound was a single {@code Mono.timeout} per call, so a
 *       connection that opened and then went silent held a request thread for the whole of it.
 * </ul>
 *
 * <h2>Sizing</h2>
 * The pool is deliberately larger than Tomcat's thread pool. The backend cannot have more calls in
 * flight than it has request threads, so a pool smaller than that turns a slow AI service into
 * queueing <em>inside</em> the backend — threads waiting to acquire a connection rather than waiting
 * on the service. Sizing it above the thread count means the bottleneck stays where it can be seen.
 */
@Configuration
public class AiWebClientConfig {

    /**
     * Comfortably above {@code server.tomcat.threads.max} (20) — see the class note on why.
     */
    private static final int MAX_CONNECTIONS = 32;

    @Bean
    public ReactorClientHttpConnector aiHttpConnector(
            @Value("${ai.connect-timeout-ms:10000}") int connectTimeoutMs,
            @Value("${ai.response-timeout-ms:120000}") int responseTimeoutMs) {

        ConnectionProvider provider = ConnectionProvider.builder("ai-service")
                .maxConnections(MAX_CONNECTIONS)
                // Fail fast rather than queue invisibly: a caller that cannot get a connection in
                // five seconds is better off being told than waiting behind a queue it cannot see.
                .pendingAcquireTimeout(Duration.ofSeconds(5))
                // The important one. Anything idle for a minute is discarded rather than reused,
                // so a connection the far end has quietly dropped is never handed out.
                .maxIdleTime(Duration.ofSeconds(60))
                // A hard ceiling on age, for connections that are busy enough never to look idle.
                .maxLifeTime(Duration.ofMinutes(10))
                .evictInBackground(Duration.ofSeconds(30))
                .build();

        HttpClient client = HttpClient.create(provider)
                .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, connectTimeoutMs)
                // Generous, because indexing a full report legitimately takes minutes. This is a
                // backstop against a silent connection, not the per-call budget — each AiClient
                // method still sets its own, tighter timeout.
                .responseTimeout(Duration.ofMillis(responseTimeoutMs))
                .doOnConnected(conn -> conn.addHandlerLast(
                        new ReadTimeoutHandler(responseTimeoutMs / 1000)));

        return new ReactorClientHttpConnector(client);
    }
}
