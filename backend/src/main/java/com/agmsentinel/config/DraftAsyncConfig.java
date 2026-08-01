package com.agmsentinel.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

import java.util.concurrent.Executor;

/**
 * A small dedicated pool for drafting answers.
 *
 * <p>Its own pool rather than the common one for two reasons. Drafting spends almost all of its time
 * blocked on the model — including deliberate sleeps between retries — so it must not sit in a queue
 * behind a video transcode, and a transcode must not sit behind it. And it needs to be bounded:
 * a burst of questions during a live meeting could otherwise open one model call per question
 * against a free tier that rate-limits in the single digits, which is how a burst turns every draft
 * into a failure.
 *
 * <p>{@code @EnableAsync} lives on {@link VideoAsyncConfig} and applies application-wide, so it is
 * not repeated here.
 */
@Configuration
public class DraftAsyncConfig {

    public static final String EXECUTOR = "clusterDraftExecutor";

    @Bean(EXECUTOR)
    public Executor clusterDraftExecutor() {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setCorePoolSize(2);
        executor.setMaxPoolSize(2);
        executor.setQueueCapacity(256);
        executor.setThreadNamePrefix("cluster-draft-");
        // Queue rather than drop. A draft that is merely late still reaches the board on the next
        // broadcast; one that was discarded leaves a cluster stuck at PENDING with nothing to
        // explain why, and no retry will ever pick it up.
        executor.setRejectedExecutionHandler((task, pool) -> {
            if (!pool.isShutdown()) task.run();
        });
        // Let in-flight drafts finish on shutdown instead of stranding a cluster mid-attempt.
        executor.setWaitForTasksToCompleteOnShutdown(true);
        executor.setAwaitTerminationSeconds(20);
        executor.initialize();
        return executor;
    }
}
