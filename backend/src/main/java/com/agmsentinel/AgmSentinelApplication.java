package com.agmsentinel;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.stereotype.Component;

@SpringBootApplication
@EnableScheduling
public class AgmSentinelApplication {
    public static void main(String[] args) {
        SpringApplication.run(AgmSentinelApplication.class, args);
    }

    /**
     * Report the memory budget this process is actually working with.
     *
     * <p>Exists because the alternative is guesswork. The heap ceiling can be set from the command
     * line, from {@code JAVA_TOOL_OPTIONS}, or from {@code _JAVA_OPTIONS}, and when more than one is
     * present the effective value is not obvious from the log — the JVM prints only that it
     * <em>read</em> {@code JAVA_TOOL_OPTIONS}, never what won. On a container that keeps being killed
     * for exceeding its limit, that difference is the whole question, and FFmpeg has to live in
     * whatever is left over.
     */
    @Component
    static class MemoryBudgetLogger {

        private static final Logger log = LoggerFactory.getLogger(MemoryBudgetLogger.class);

        @EventListener(ApplicationReadyEvent.class)
        void report() {
            long heapMax = Runtime.getRuntime().maxMemory();
            long container = containerMemory();

            if (container <= 0) {
                log.info("Heap ceiling {} MB (container limit unknown).", mb(heapMax));
                return;
            }
            long headroom = container - heapMax;
            log.info("Heap ceiling {} MB of a {} MB container — about {} MB left for everything "
                     + "else, FFmpeg included. Effective MaxRAMPercentage ~{}%.",
                     mb(heapMax), mb(container), mb(headroom),
                     Math.round(heapMax * 100.0 / container));

            // A transcode is a second process inside the same limit. Too little headroom and the
            // kernel kills the container mid-job, which the platform reports as a restart with no
            // stack trace and nothing in the application log to explain it.
            if (headroom < 200L * 1024 * 1024) {
                log.warn("Only {} MB is left outside the heap. An FFmpeg encode needs roughly "
                         + "150-250 MB, so a transcode may get this container killed. Lower the heap "
                         + "(JAVA_HEAP_PERCENT), or set VIDEO_TRANSCODE_ENABLED=false and upload "
                         + "browser-playable MP4/WebM instead.", mb(headroom));
            }
        }

        /** Container-aware since JDK 14: reports the cgroup limit, not the host's RAM. */
        private long containerMemory() {
            try {
                var os = (com.sun.management.OperatingSystemMXBean)
                        java.lang.management.ManagementFactory.getOperatingSystemMXBean();
                return os.getTotalMemorySize();
            } catch (RuntimeException | LinkageError ex) {
                return -1;
            }
        }

        private long mb(long bytes) {
            return bytes / (1024 * 1024);
        }
    }
}
