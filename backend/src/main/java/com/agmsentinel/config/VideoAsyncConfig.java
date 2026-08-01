package com.agmsentinel.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import java.util.concurrent.Executor;

/**
 * A dedicated, deliberately small pool for video transcoding.
 *
 * <p>Transcoding is CPU-bound and long-running: one 45-minute recording can saturate every core
 * for minutes. Running it on the request thread would block the HTTP connection until ffmpeg
 * finished (and the browser would time out), and running it on the common Spring pool would
 * starve the board broadcast. So uploads return immediately with {@code status=PROCESSING} and
 * the real work happens here, at most {@code video.tools.workers} at a time; the rest queue.
 */
@Configuration
@EnableAsync
public class VideoAsyncConfig {

    public static final String EXECUTOR = "videoTranscodeExecutor";

    @Bean(EXECUTOR)
    public Executor videoTranscodeExecutor(VideoProperties props) {
        int workers = Math.max(1, props.getTools().getWorkers());
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(workers);
        executor.setMaxPoolSize(workers);
        executor.setQueueCapacity(64);
        executor.setThreadNamePrefix("video-transcode-");
        // Don't drop a job because the queue filled: block the caller instead. Uploads are rare
        // enough that queueing is the right answer, and a silently discarded video is far worse.
        executor.setRejectedExecutionHandler((r, e) -> {
            if (!e.isShutdown()) r.run();
        });
        executor.initialize();
        return executor;
    }
}
