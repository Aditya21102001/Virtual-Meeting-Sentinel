package com.agmsentinel.repository;

import com.agmsentinel.model.Question;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface QuestionRepository extends JpaRepository<Question, UUID> {
    long countByClusterId(UUID clusterId);
}
