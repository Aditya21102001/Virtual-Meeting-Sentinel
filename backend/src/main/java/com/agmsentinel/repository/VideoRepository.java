package com.agmsentinel.repository;

import com.agmsentinel.model.Video;
import com.agmsentinel.model.VideoStatus;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface VideoRepository extends JpaRepository<Video, UUID> {

    /** Newest first — the catalogue order for the admin screen. */
    @EntityGraph(attributePaths = "renditions")
    List<Video> findAllByOrderByCreatedAtDesc();

    /** What viewers may see: only fully processed videos. */
    @EntityGraph(attributePaths = "renditions")
    List<Video> findByStatusOrderByCreatedAtDesc(VideoStatus status);

    @EntityGraph(attributePaths = "renditions")
    Optional<Video> findWithRenditionsById(UUID id);
}
