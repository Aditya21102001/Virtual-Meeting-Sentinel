package com.agmsentinel.service;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * Periodically re-broadcasts the board so priority re-rankings and late drafts reach
 * moderators even during quiet moments — and doubles as a keep-warm ping to the AI service.
 */
@Component
public class BoardRefreshScheduler {

    private final QuestionService service;

    public BoardRefreshScheduler(QuestionService service) {
        this.service = service;
    }

    @Scheduled(fixedDelayString = "${board.refresh-ms:10000}")
    public void refresh() {
        try {
            service.broadcastBoard();
        } catch (Exception ignored) {
            // AI service may be cold-starting; next tick will succeed.
        }
    }
}
