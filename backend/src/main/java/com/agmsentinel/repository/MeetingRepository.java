package com.agmsentinel.repository;

import com.agmsentinel.model.Meeting;
import com.agmsentinel.model.MeetingStatus;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface MeetingRepository extends JpaRepository<Meeting, UUID> {

    /**
     * The live meeting, if there is one.
     *
     * <p>Returns an Optional rather than a list because there can only be one — the partial unique
     * index on {@code status = 'ACTIVE'} guarantees it at the database, so anything that found two
     * would be reporting corruption rather than a case to handle.
     */
    Optional<Meeting> findFirstByStatus(MeetingStatus status);

    List<Meeting> findAllByOrderByCreatedAtDesc();

    List<Meeting> findByStatusOrderByCreatedAtDesc(MeetingStatus status);

    boolean existsByTitleIgnoreCase(String title);
}
