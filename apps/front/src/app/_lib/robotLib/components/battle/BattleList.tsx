import {
  useGenerateGameSignature,
  useGetUserRobots,
  useJoinBattle,
  useListBattles,
} from "@/app/_lib/robotLib/robotHooks";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  type BattleId,
  type BattleStatus,
  RobotId,
  type UserId,
} from "robot-sdk";
import { toast } from "sonner";
import { useAccount, useWalletClient } from "wagmi";
import { enterGame } from "../../robotContract";
import { BattleCard } from "./BattleCard";

interface BattleRoom {
  id: BattleId;
  createdBy: UserId;
  robot1Id: RobotId;
  createdAt: Date;
  expiresAt: Date;
  gameId: number;
}

interface JoinRoomResponse {
  battleId: BattleId;
  status: BattleStatus;
}

interface BattleCardProps {
  id: string;
  createdBy: string;
  robots: Array<{ id: string; name: string; imageUrl?: string | null }>;
  createdAt: Date;
  completedAt: Date | null;
  gameId: number;
  onJoin: () => void;
  isLoading?: boolean;
}

export function BattlesList() {
  const router = useRouter();
  const { address } = useAccount();
  const { data: userRobots } = useGetUserRobots();
  const [selectedRobotId, setSelectedRobotId] = useState<RobotId | null>(null);
  const [selectedBattleId, setSelectedBattleId] = useState<BattleId | null>(
    null,
  );
  const [selectedGameId, setSelectedGameId] = useState<number | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const generateSignature = useGenerateGameSignature();

  const {
    data: battles,
    isLoading,
    refetch,
  } = useListBattles({
    page: "1",
    limit: "10",
  });

  const joinBattle = useJoinBattle();

  const walletClient = useWalletClient();
  const handleJoinBattle = async () => {
    if (!selectedRobotId || !selectedBattleId || !address || !selectedGameId)
      return;

    try {
      setIsProcessing(true);

      // 1. Join battle in our backend
      console.log("Joining battle with:", {
        battleId: selectedBattleId,
        gameId: selectedGameId,
        robotId: selectedRobotId,
      });
      const battleData = await joinBattle.mutateAsync({
        battleId: selectedBattleId,
        gameId: selectedGameId,
        robotId: selectedRobotId,
      });

      // 2. Get signature from backend
      const signatureData = await generateSignature.mutateAsync({
        gameId: battleData.gameId,
        userAddress: address,
      });

      // 3. Send transaction using user's wallet and wait for confirmation
      if (!walletClient.data) {
        throw new Error("Wallet client not found");
      }
      await enterGame({
        gameId: BigInt(battleData.gameId),
        signature: signatureData.signature,
        walletClient: walletClient.data,
      });

      // 4. Navigate to battle page
      router.push(`/battle/${selectedBattleId}`);
      toast.success("Successfully joined battle!");
    } catch (error) {
      console.error("Join battle error:", error);
      toast.error("Failed to join battle");
    } finally {
      setIsProcessing(false);
      setSelectedRobotId(null);
      setSelectedBattleId(null);
      setSelectedGameId(null);
    }
  };

  const isDisabled =
    !selectedRobotId ||
    !selectedBattleId ||
    !address ||
    isProcessing ||
    joinBattle.isPending;

  if (isLoading) {
    return <div>Loading rooms...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Available Battle Rooms</h2>
        <Button onClick={() => refetch()} variant="outline">
          Refresh
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {battles?.battles.map((room) => (
          <Dialog
            key={room.id}
            onOpenChange={(open) => {
              if (!open) {
                setSelectedRobotId(null);
                setSelectedBattleId(null);
                setSelectedGameId(null);
              }
            }}
          >
            <DialogTrigger asChild>
              <div>
                <BattleCard
                  id={room.id}
                  createdBy={room.createdBy}
                  robots={room.robots}
                  createdAt={new Date(room.createdAt)}
                  completedAt={
                    room.completedAt ? new Date(room.completedAt) : null
                  }
                  gameId={room.gameId}
                  onJoin={() => {
                    console.log("Game ID selected:", room.gameId);
                    setSelectedBattleId(room.id);
                    setSelectedGameId(room.gameId);
                  }}
                  isLoading={joinBattle.isPending}
                />
              </div>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Select Your Robot</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <Select
                  onValueChange={(value) =>
                    setSelectedRobotId(RobotId.parse(value))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Choose your robot" />
                  </SelectTrigger>
                  <SelectContent>
                    {userRobots?.robots.map((robot) => (
                      <SelectItem key={robot.id} value={robot.id}>
                        {robot.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  className="w-full"
                  disabled={isDisabled}
                  onClick={handleJoinBattle}
                >
                  {isProcessing
                    ? "Processing Transaction..."
                    : joinBattle.isPending
                      ? "Joining..."
                      : "Join Battle"}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        ))}
        {battles?.battles.length === 0 && (
          <p className="col-span-full py-8 text-center text-muted-foreground">
            No battle rooms available. Create one to start battling!
          </p>
        )}
      </div>
    </div>
  );
}
