package com.agmsentinel.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;

import java.util.Map;

/**
 * Publishes each submitted question to the `questions.incoming` Kafka topic — the durable,
 * retained log that the Python AI service consumes (and replays from offset 0 on restart to
 * rebuild its in-memory clusters). This is the event-sourced ingest backbone.
 *
 * Active only when queue.mode=kafka; otherwise the bean is never created and QuestionService
 * falls back to the synchronous HTTP /ingest path.
 */
@Component
@ConditionalOnProperty(name = "queue.mode", havingValue = "kafka")
public class KafkaQuestionProducer {

    private final KafkaTemplate<String, String> kafka;
    private final ObjectMapper mapper = new ObjectMapper();
    private final String topic;

    public KafkaQuestionProducer(KafkaTemplate<String, String> kafka,
                                 @Value("${queue.kafka.questions-topic:questions.incoming}") String topic) {
        this.kafka = kafka;
        this.topic = topic;
    }

    /**
     * Append one question to the log. Keyed by questionId so all events for a question land on
     * the same partition (preserving per-question order). Fire-and-forget: the AI service
     * clusters it asynchronously and the scheduled board push reflects it to moderators.
     */
    public void publish(String questionId, String text, String attendeeId, float weight) {
        publish(questionId, text, attendeeId, weight, null);
    }

    public void publish(String questionId, String text, String attendeeId, float weight, java.util.UUID meetingId) {
        try {
            java.util.Map<String, Object> map = new java.util.HashMap<>();
            map.put("question_id", questionId);
            map.put("text", text);
            map.put("attendee_id", attendeeId);
            map.put("weight", weight);
            if (meetingId != null) {
                map.put("meeting_id", meetingId.toString());
            }
            String json = mapper.writeValueAsString(map);
            kafka.send(topic, questionId, json);
        } catch (Exception e) {
            throw new RuntimeException("Failed to publish question to Kafka topic " + topic + ": " + e.getMessage(), e);
        }
    }
}
