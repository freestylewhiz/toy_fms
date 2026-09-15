# 참고문헌

서지 웹 확인 (2026-09). v0 [`../traffic_control_v0/references.md`](../traffic_control_v0/references.md) 의 [R4] 조정도표와 이어진다.

---

## 속도 조절 · 조정도표

Kant, K., & Zucker, S. W. (1986). **Toward Efficient Trajectory Planning: The Path-Velocity Decomposition.**
*IEEE Transactions on Systems, Man, and Cybernetics*, 16(3).

O'Donnell, P. A., & Lozano-Pérez, T. (1989). **Deadlock-Free and Collision-Free Coordination of Two Robot Manipulators.** ICRA.

Siméon, T., Leroy, S., & Laumond, J.-P. (2002). **Path Coordination for Multiple Mobile Robots: A Resolution-Complete Algorithm.** *IEEE T-RA*, 18(1).
DOI: [10.1109/70.988973](https://doi.org/10.1109/70.988973)

Petrinić, T., et al. **Minimum Startup Delay Approach to Coordination of Multiple Mobile Robots Motion Along Predefined Paths.**

---

## 시공간 예약 · 우선순위

Silver, D. (2005). **Cooperative Pathfinding.** *AIIDE*.
HCA* / Cooperative A*, reservation table.

Čáp, M., et al. (2015/2019). **Multi-Robot Path Deconfliction through Prioritization by Path Prospects.**
arXiv: [1908.02361](https://arxiv.org/abs/1908.02361)

Chari, A., Chen, R., & Liu, C. (2023). **Space-Time Conflict Spheres for Constrained Multi-Agent Motion Planning.**
arXiv: [2302.02266](https://arxiv.org/abs/2302.02266)

---

## 로컬 교행

Fiorini, P., & Shiller, Z. (1998). **Motion Planning in Dynamic Environments Using Velocity Obstacles.** *IJRR*.

van den Berg, J., Lin, M., & Manocha, D. (2008). **Reciprocal Velocity Obstacles for Real-Time Multi-Agent Navigation.** ICRA.

van den Berg, J., Guy, S. J., Lin, M., & Manocha, D. (2011). **Reciprocal n-body Collision Avoidance.** *ISRR* / ORCA.
<https://gamma.cs.unc.edu/ORCA/>

---

## 산업 FMS · 존

Open-RMF `rmf_traffic`: itinerary schedule, `delay()`, Negotiation (`QuickestFinishEvaluator`), mutex groups.
<https://github.com/open-rmf/rmf_traffic>

**VDA 5050 Version 3.0.0** (VDA/VDMA, 2025). 모바일 로봇 ↔ 플릿 MQTT.
자유주행 경로 공유(`intermediatePath.eta`), `zoneSet`, edge `corridor`, base/horizon.
정리: [`vda5050/README.md`](./vda5050/README.md).
원문: <https://github.com/VDA5050/VDA5050>

VDMA **LIF – Layout Interchange Format** (2024-03). 노드·엣지·스테이션 교환. MQTT가 아님.
맵 에디터 그래프 가져오기/내보내기: [`vda5050/04_map_editor.md`](./vda5050/04_map_editor.md).

Open Robotics. **Programming Multiple Robots with ROS 2 — Graph Strategies** (mutex, lane cost).
<https://osrf.github.io/ros2multirobotbook/integration_nav-maps-strategies.html>

Jeong, S., et al. (2022). **Layered-Cost-Map-Based Traffic Management for Multiple AMRs via a DDS.** *Applied Sciences*, 12(16), 8084.
DOI: [10.3390/app12168084](https://doi.org/10.3390/app12168084)

(금지 / 레인 / region ticket 이 사용자 존 카탈로그와 대응.)

---

## 우리 문서와의 관계

| 출처 | v2 에서 |
|------|---------|
| Kant–Zucker, 조정도표 | L1 대기, 경로 유지 |
| HCA* 예약 테이블 | L3 짧은 시공간 재계획 |
| ORCA | L2 교행 횡변위 |
| Open-RMF delay / negotiation | L4 FMS, 좌표 없는 중재 |
| VDA 5050 base/horizon, zoneSet, intermediatePath.eta | 이기종 게이트 + 자유주행 로컬 플랜 입력 |
| Open-RMF mutex, Jeong costmap | 사용자 존 모듈 |
| v0 I1/I2 | 존·응급 회랑에만 국소 적용 |
