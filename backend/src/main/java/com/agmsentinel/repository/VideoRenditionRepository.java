package com.agmsentinel.repository;

import com.agmsentinel.model.VideoRendition;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface VideoRenditionRepository extends JpaRepository<VideoRendition, UUID> {

    List<VideoRendition> findByVideoIdOrderByHeightDesc(UUID videoId);

    Optional<VideoRendition> findByVideoIdAndName(UUID videoId, String name);
}
